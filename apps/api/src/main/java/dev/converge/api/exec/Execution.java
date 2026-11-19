package dev.converge.api.exec;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import dev.converge.api.agent.AgentTurns;
import dev.converge.api.audit.AuditLog;
import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.CollabClient;
import dev.converge.api.realtime.WorkspaceEvent;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * Approvals and jobs (design §11, §13.7). An approval authorizes one exact action once: the first answer wins
 * by compare-and-set, unanswered cards expire, and approving queues a job that the executor runs only after
 * re-checking the approval itself. Interrupted jobs are never retried; a person records their outcome.
 */
@Service
public class Execution {

    public record Job(UUID id, UUID approvalId, String command, String status, Integer exitCode, String error,
            String outcome, Instant createdAt, Instant startedAt, Instant endedAt) {
    }

    public record Chunk(int seq, String stream, String chunk) {
    }

    public record JobDetail(Job job, List<Chunk> output) {
    }

    public record Approval(UUID id, UUID sessionId, UUID turnId, UUID requestedBy, String requesterName, String command,
            List<String> capabilities, String status, UUID decidedBy, String deciderName, int rowVersion,
            Instant expiresAt, Instant createdAt, Job job) {
    }

    static final List<String> CAPABILITIES = List.of("run a command in the sandbox (no network)");
    private static final int MAX_OUTPUT_CHUNKS = 2000;

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final AgentTurns turns;
    private final CollabClient collab;
    private final AuditLog audit;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;
    private final Duration approvalTtl;

    public Execution(JdbcClient jdbc, WorkspaceAccess access, AgentTurns turns, CollabClient collab, AuditLog audit,
            ApplicationEventPublisher events, TransactionTemplate tx,
            @Value("${converge.agent.approval-ttl:PT10M}") Duration approvalTtl) {
        this.jdbc = jdbc;
        this.access = access;
        this.turns = turns;
        this.collab = collab;
        this.audit = audit;
        this.events = events;
        this.tx = tx;
        this.approvalTtl = approvalTtl;
    }

    // ---- Requests -------------------------------------------------------------------------------------

    /** An agent asks to run a command: a pending card everyone in the workspace sees (design §13.7). */
    public Approval requestForTurn(UUID turnId, String rawCommand) {
        AgentTurns.TurnRef turn = turns.runningRef(turnId);
        String command = CommandTemplates.require(rawCommand);
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> {
            insertApproval(id, turn.workspaceId(), turn.sessionId(), turnId, turn.sponsorId(), command, "PENDING", null);
            turns.recordEvent(turnId, Map.of("kind", "approval", "text", command, "approvalId", id.toString()));
            changed(turn.workspaceId(), turn.sponsorId(), "APPROVAL_CHANGED", Map.of("approvalId", id));
        });
        return approval(id);
    }

    /** A member runs an allowlisted command themselves: their request is their approval (browser-only members). */
    public Approval runDirect(UUID workspaceId, UUID userId, String rawCommand) {
        access.require(workspaceId, userId, Role.EDITOR);
        String command = CommandTemplates.require(rawCommand);
        flushWorkspace(workspaceId);
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> {
            insertApproval(id, workspaceId, null, null, userId, command, "APPROVED", userId);
            queueJob(id, workspaceId, userId, command);
            audit.record(workspaceId, userId, "job.requested", "approval", id, Map.of("command", command));
            changed(workspaceId, userId, "APPROVAL_CHANGED", Map.of("approvalId", id));
        });
        return approval(id);
    }

    /**
     * Answers a card. Any editor or owner may answer; the first valid answer wins and a second one is told it
     * was already decided. Approving queues the job in the same transaction.
     */
    public Approval decide(UUID approvalId, UUID userId, boolean approve, int rowVersion) {
        UUID workspaceId = workspaceOf(approvalId);
        access.require(workspaceId, userId, Role.EDITOR);
        if (approve) flushWorkspace(workspaceId);
        tx.executeWithoutResult(status -> {
            int updated = jdbc.sql("""
                    update approvals set status = ?, decided_by = ?, decided_at = now(), row_version = row_version + 1
                    where id = ? and row_version = ? and status = 'PENDING' and expires_at > now()
                    """).params(approve ? "APPROVED" : "DENIED", userId, approvalId, rowVersion).update();
            if (updated == 0) {
                String current = jdbc.sql("select case when status = 'PENDING' and expires_at <= now() then 'EXPIRED' else status end from approvals where id = ?")
                        .param(approvalId).query(String.class).single();
                throw ApiException.conflict("PENDING".equals(current)
                        ? "The card changed meanwhile; reload it"
                        : "This card was already " + current.toLowerCase());
            }
            record Row(String command, UUID requestedBy) {
            }
            Row row = jdbc.sql("select action->>'command', requested_by from approvals where id = ?").param(approvalId)
                    .query((rs, n) -> new Row(rs.getString(1), rs.getObject(2, UUID.class))).single();
            if (approve) queueJob(approvalId, workspaceId, row.requestedBy(), row.command());
            audit.record(workspaceId, userId, approve ? "approval.approved" : "approval.denied", "approval", approvalId,
                    Map.of("command", row.command()));
            changed(workspaceId, userId, "APPROVAL_CHANGED", Map.of("approvalId", approvalId));
        });
        return approval(approvalId);
    }

    @Scheduled(fixedDelay = 30_000)
    public void expireStale() {
        record Expired(UUID id, UUID workspaceId) {
        }
        jdbc.sql("""
                update approvals set status = 'EXPIRED', row_version = row_version + 1
                where status = 'PENDING' and expires_at <= now() returning id, workspace_id
                """)
                .query((rs, n) -> new Expired(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)))
                .list()
                .forEach(e -> events.publishEvent(WorkspaceEvent.of("APPROVAL_CHANGED", e.workspaceId(), null,
                        Map.of("approvalId", e.id()))));
    }

    /** For a job that was interrupted mid-run, a person says what actually happened (design §13.12). */
    public Job recordOutcome(UUID jobId, UUID userId, String outcome) {
        if (!"SUCCEEDED".equals(outcome) && !"FAILED".equals(outcome)) throw ApiException.badRequest("Outcome must be SUCCEEDED or FAILED");
        UUID workspaceId = jobWorkspace(jobId);
        access.require(workspaceId, userId, Role.EDITOR);
        tx.executeWithoutResult(status -> {
            int updated = jdbc.sql("update jobs set outcome = ?, outcome_by = ? where id = ? and status = 'OUTCOME_UNKNOWN' and outcome is null")
                    .params(outcome, userId, jobId).update();
            if (updated == 0) throw ApiException.conflict("Only a job whose outcome is unknown, and not yet recorded, takes an outcome");
            audit.record(workspaceId, userId, "job.outcome_recorded", "job", jobId, Map.of("outcome", outcome));
            changed(workspaceId, userId, "JOB_UPDATED", Map.of("jobId", jobId));
        });
        return job(jobId);
    }

    // ---- Reads ----------------------------------------------------------------------------------------

    public List<Approval> list(UUID workspaceId, UUID userId, UUID sessionId) {
        access.require(workspaceId, userId, Role.VIEWER);
        return jdbc.sql("""
                select id from approvals where workspace_id = ? and (cast(? as uuid) is null or session_id = ?)
                order by created_at desc limit 100
                """).params(workspaceId, sessionId, sessionId).query(UUID.class).list()
                .reversed().stream().map(this::approval).toList();
    }

    public JobDetail detail(UUID jobId, UUID userId) {
        access.require(jobWorkspace(jobId), userId, Role.VIEWER);
        return new JobDetail(job(jobId), output(jobId));
    }

    Approval approval(UUID id) {
        return jdbc.sql("""
                select a.*, a.action->>'command' as command, r.display_name as requester, d.display_name as decider,
                       j.id as job_id
                from approvals a join users r on r.id = a.requested_by left join users d on d.id = a.decided_by
                left join jobs j on j.approval_id = a.id
                where a.id = ?
                """).param(id)
                .query((rs, n) -> {
                    UUID jobId = rs.getObject("job_id", UUID.class);
                    String status = rs.getString("status");
                    if ("PENDING".equals(status) && rs.getTimestamp("expires_at").toInstant().isBefore(Instant.now())) status = "EXPIRED";
                    return new Approval(rs.getObject("id", UUID.class), rs.getObject("session_id", UUID.class),
                            rs.getObject("turn_id", UUID.class), rs.getObject("requested_by", UUID.class),
                            rs.getString("requester"), rs.getString("command"), CAPABILITIES, status,
                            rs.getObject("decided_by", UUID.class), rs.getString("decider"), rs.getInt("row_version"),
                            rs.getTimestamp("expires_at").toInstant(), rs.getTimestamp("created_at").toInstant(),
                            jobId == null ? null : job(jobId));
                })
                .optional().orElseThrow(() -> ApiException.notFound("Approval"));
    }

    Job job(UUID jobId) {
        return jdbc.sql("select * from jobs where id = ?").param(jobId)
                .query((rs, n) -> toJob(rs)).optional().orElseThrow(() -> ApiException.notFound("Job"));
    }

    List<Chunk> output(UUID jobId) {
        List<Chunk> chunks = jdbc.sql("""
                select seq, stream, chunk from job_output where job_id = ? order by seq desc limit ?
                """).params(jobId, MAX_OUTPUT_CHUNKS)
                .query((rs, n) -> new Chunk(rs.getInt(1), rs.getString(2), rs.getString(3))).list();
        return new ArrayList<>(chunks).reversed();
    }

    // ---- Called by the executor, through ExecutionInternalController -----------------------------------

    void appendOutput(UUID jobId, List<Map<String, String>> chunks) {
        UUID workspaceId = jobWorkspace(jobId);
        tx.executeWithoutResult(status -> {
            int seq = jdbc.sql("select coalesce(max(seq), 0) from job_output where job_id = ?").param(jobId)
                    .query(Integer.class).single();
            List<Map<String, Object>> published = new ArrayList<>();
            for (Map<String, String> chunk : chunks) {
                String stream = chunk.getOrDefault("stream", "stdout");
                if (!List.of("stdout", "stderr", "system").contains(stream)) throw ApiException.badRequest("Unknown stream");
                String text = chunk.getOrDefault("chunk", "");
                if (text.length() > 64_000) text = text.substring(0, 64_000);
                jdbc.sql("insert into job_output (job_id, seq, stream, chunk) values (?, ?, ?, ?)")
                        .params(jobId, ++seq, stream, text).update();
                published.add(Map.of("seq", seq, "stream", stream, "chunk", text));
            }
            events.publishEvent(WorkspaceEvent.of("JOB_OUTPUT", workspaceId, null, Map.of("jobId", jobId, "chunks", published)));
        });
    }

    /** RUNNING to a final state, once. A final state is never changed by the executor again. */
    void finishJob(UUID jobId, String status, Integer exitCode, String error) {
        UUID workspaceId = jobWorkspace(jobId);
        tx.executeWithoutResult(t -> {
            int updated = jdbc.sql("""
                    update jobs set status = ?, exit_code = ?, error = ?, ended_at = now()
                    where id = ? and status in ('QUEUED', 'RUNNING')
                    """).params(status, exitCode, error, jobId).update();
            if (updated == 0) throw ApiException.conflict("The job has already finished");
            changed(workspaceId, null, "JOB_UPDATED", Map.of("jobId", jobId));
        });
    }

    void started(UUID jobId) {
        changed(jobWorkspace(jobId), null, "JOB_UPDATED", Map.of("jobId", jobId));
    }

    // ---- Called by the runner, for the turn that asked ----------------------------------------------

    Approval approvalForTurn(UUID turnId, UUID approvalId) {
        Approval approval = approval(approvalId);
        if (!turnId.equals(approval.turnId())) throw ApiException.notFound("Approval");
        return approval;
    }

    JobDetail jobForTurn(UUID turnId, UUID jobId) {
        UUID approvalTurn = jdbc.sql("select a.turn_id from jobs j join approvals a on a.id = j.approval_id where j.id = ?")
                .param(jobId).query(UUID.class).optional().orElse(null);
        if (!turnId.equals(approvalTurn)) throw ApiException.notFound("Job");
        return new JobDetail(job(jobId), output(jobId));
    }

    // ---- Helpers --------------------------------------------------------------------------------------

    private void insertApproval(UUID id, UUID workspaceId, UUID sessionId, UUID turnId, UUID requestedBy,
            String command, String status, UUID decidedBy) {
        String canonical = CommandTemplates.canonical(workspaceId, command);
        jdbc.sql("""
                insert into approvals (id, workspace_id, session_id, turn_id, requested_by, action, action_hash,
                    capabilities, status, decided_by, decided_at, expires_at)
                values (?, ?, ?, ?, ?, cast(? as jsonb), ?, cast(? as jsonb), ?, ?, case when ? then now() end, ?)
                """)
                .params(id, workspaceId, sessionId, turnId, requestedBy, canonical, CommandTemplates.hash(canonical),
                        "[\"execute:sandbox\"]", status, decidedBy, decidedBy != null,
                        Timestamp.from(Instant.now().plus(approvalTtl)))
                .update();
    }

    private void queueJob(UUID approvalId, UUID workspaceId, UUID requestedBy, String command) {
        UUID jobId = UUID.randomUUID();
        jdbc.sql("insert into jobs (id, workspace_id, approval_id, requested_by, command) values (?, ?, ?, ?, ?)")
                .params(jobId, workspaceId, approvalId, requestedBy, command).update();
        changed(workspaceId, requestedBy, "JOB_UPDATED", Map.of("jobId", jobId));
    }

    /** The sandbox gets the stored text of every file, so pending typing is stored first (design §11.2). */
    private void flushWorkspace(UUID workspaceId) {
        List<UUID> files = jdbc.sql("select id from files where workspace_id = ? and kind = 'FILE' and deleted_at is null")
                .param(workspaceId).query(UUID.class).list();
        try {
            files.forEach(collab::flush);
        } catch (ApiException e) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "The workspace files could not be prepared; try again");
        }
    }

    private UUID workspaceOf(UUID approvalId) {
        return jdbc.sql("select workspace_id from approvals where id = ?").param(approvalId).query(UUID.class)
                .optional().orElseThrow(() -> ApiException.notFound("Approval"));
    }

    private UUID jobWorkspace(UUID jobId) {
        return jdbc.sql("select workspace_id from jobs where id = ?").param(jobId).query(UUID.class)
                .optional().orElseThrow(() -> ApiException.notFound("Job"));
    }

    private void changed(UUID workspaceId, UUID actorId, String type, Map<String, Object> payload) {
        events.publishEvent(WorkspaceEvent.of(type, workspaceId, actorId, payload));
    }

    private static Job toJob(ResultSet rs) throws SQLException {
        Integer exit = rs.getObject("exit_code", Integer.class);
        return new Job(rs.getObject("id", UUID.class), rs.getObject("approval_id", UUID.class), rs.getString("command"),
                rs.getString("status"), exit, rs.getString("error"), rs.getString("outcome"),
                instant(rs.getTimestamp("created_at")), instant(rs.getTimestamp("started_at")),
                instant(rs.getTimestamp("ended_at")));
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
