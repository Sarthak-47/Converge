package dev.converge.api.session;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.transaction.support.TransactionTemplate;

import dev.converge.api.agent.AgentTurns;
import dev.converge.api.agent.AgentTurns.Turn;
import dev.converge.api.audit.AuditLog;
import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.WorkspaceEvent;
import dev.converge.api.workspace.MemberService.AccessChanged;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * Sessions (design §13.3, §13.8): one task, one plan, a lane per participant and visible watchers. The
 * session's driver is the member whose agent carries the plan and pays for it; it changes only by takeover,
 * handoff or completion, each a compare-and-set on row_version so that of two simultaneous takeovers exactly
 * one wins.
 */
@Service
public class Sessions {

    public enum Mode { LANE, WATCH }

    public record Participant(UUID userId, String displayName, Mode mode) {
    }

    /** A board card (design §13.9): everything needed to decide whether to join, watch or take over. */
    public record Card(UUID id, String task, String status, UUID driverId, String driverName, int rowVersion,
            List<Participant> participants, int stepsDone, int stepsTotal, List<String> files, int runningTurns,
            Instant createdAt, Instant endedAt) {
    }

    public record Detail(Card session, List<Plans.Step> plan, List<Turn> turns) {
    }

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final Plans plans;
    private final AgentTurns turns;
    private final AuditLog audit;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;

    public Sessions(JdbcClient jdbc, WorkspaceAccess access, Plans plans, AgentTurns turns, AuditLog audit,
            ApplicationEventPublisher events, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.access = access;
        this.plans = plans;
        this.turns = turns;
        this.audit = audit;
        this.events = events;
        this.tx = tx;
    }

    public Card create(UUID workspaceId, UUID userId, String task) {
        access.require(workspaceId, userId, Role.EDITOR);
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> {
            jdbc.sql("insert into sessions (id, workspace_id, task, driver_id, created_by) values (?, ?, ?, ?, ?)")
                    .params(id, workspaceId, task, userId, userId).update();
            jdbc.sql("insert into session_participants (session_id, user_id, mode) values (?, ?, 'LANE')")
                    .params(id, userId).update();
            audit.record(workspaceId, userId, "session.created", "session", id, Map.of());
            changed(workspaceId, userId, id);
        });
        return card(id);
    }

    /** Active sessions first, then the most recent finished ones. */
    public List<Card> board(UUID workspaceId, UUID userId) {
        access.require(workspaceId, userId, Role.VIEWER);
        return jdbc.sql("""
                select id from sessions where workspace_id = ?
                order by (status = 'DONE'), created_at desc limit 50
                """).param(workspaceId).query(UUID.class).list().stream().map(this::card).toList();
    }

    public Detail detail(UUID sessionId, UUID userId) {
        Card card = card(sessionId);
        UUID workspaceId = workspaceOf(sessionId);
        access.require(workspaceId, userId, Role.VIEWER);
        return new Detail(card, plans.steps(sessionId), turns.list(workspaceId, sessionId, userId));
    }

    /**
     * Joins as a lane (an editor who will prompt their own agent) or as a watcher. Watching is read-only and
     * visible: there is no invisible lurking (design §13.3).
     */
    public Card join(UUID sessionId, UUID userId, Mode mode) {
        UUID workspaceId = workspaceOf(sessionId);
        access.require(workspaceId, userId, mode == Mode.LANE ? Role.EDITOR : Role.VIEWER);
        tx.executeWithoutResult(status -> {
            jdbc.sql("""
                    insert into session_participants (session_id, user_id, mode) values (?, ?, ?)
                    on conflict (session_id, user_id) do update set mode = excluded.mode
                    """).params(sessionId, userId, mode.name()).update();
            changed(workspaceId, userId, sessionId);
        });
        return card(sessionId);
    }

    public Card leave(UUID sessionId, UUID userId) {
        UUID workspaceId = workspaceOf(sessionId);
        access.require(workspaceId, userId, Role.VIEWER);
        Card card = card(sessionId);
        if (userId.equals(card.driverId()) && !"DONE".equals(card.status())) {
            throw ApiException.conflict("Hand the session over or finish it before leaving");
        }
        tx.executeWithoutResult(status -> {
            jdbc.sql("delete from session_participants where session_id = ? and user_id = ?").params(sessionId, userId).update();
            changed(workspaceId, userId, sessionId);
        });
        return card(sessionId);
    }

    /**
     * Takes over the session (design §13.8): the previous driver's running turn stops at its next checkpoint,
     * and a new turn starts on the taker's own key with the task, plan and recent progress carried over.
     * Compare-and-set on row_version: a second, simultaneous takeover gets a conflict and is offered to join.
     */
    public Turn takeover(UUID sessionId, UUID userId, String displayName, int rowVersion, String guidance) {
        UUID workspaceId = workspaceOf(sessionId);
        access.require(workspaceId, userId, Role.EDITOR);
        Card before = card(sessionId);
        if (userId.equals(before.driverId())) throw ApiException.conflict("You are already driving this session");
        turns.requireKey(userId);
        int won = jdbc.sql("""
                update sessions set driver_id = ?, status = 'ACTIVE', row_version = row_version + 1
                where id = ? and row_version = ? and status <> 'DONE'
                """).params(userId, sessionId, rowVersion).update();
        if (won == 0) {
            throw ApiException.conflict("Someone else changed this session first (for example, took it over); join it instead");
        }
        audit.record(workspaceId, userId, "session.taken_over", "session", sessionId,
                Map.of("from", before.driverId().toString()));
        jdbc.sql("""
                insert into session_participants (session_id, user_id, mode) values (?, ?, 'LANE')
                on conflict (session_id, user_id) do update set mode = 'LANE'
                """).params(sessionId, userId).update();
        for (UUID running : jdbc.sql("select id from agent_turns where session_id = ? and sponsor_id = ? and status = 'RUNNING'")
                .params(sessionId, before.driverId()).query(UUID.class).list()) {
            try {
                turns.stop(running, "Stopped because " + displayName + " took over the session");
            } catch (ApiException e) {
                // The runner is unreachable; the turn's next call to the API fails its checks and it ends.
            }
        }
        changed(workspaceId, userId, sessionId);
        return turns.start(workspaceId, sessionId, userId, displayName,
                carryOver(sessionId, before, displayName, guidance));
    }

    /** The driver hands the session and their unfinished plan steps to another editor (design §13.8). */
    public Card handoff(UUID sessionId, UUID userId, UUID toUserId, int rowVersion) {
        UUID workspaceId = workspaceOf(sessionId);
        access.require(workspaceId, userId, Role.EDITOR);
        try {
            access.require(workspaceId, toUserId, Role.EDITOR);
        } catch (ApiException e) {
            throw ApiException.badRequest("The session can only be handed to an editor of this workspace");
        }
        tx.executeWithoutResult(status -> {
            int updated = jdbc.sql("""
                    update sessions set driver_id = ?, status = 'ACTIVE', row_version = row_version + 1
                    where id = ? and row_version = ? and driver_id = ? and status <> 'DONE'
                    """).params(toUserId, sessionId, rowVersion, userId).update();
            if (updated == 0) throw ApiException.conflict("Only the current driver can hand the session over, and it changed meanwhile");
            int steps = plans.transfer(sessionId, userId, toUserId);
            jdbc.sql("""
                    insert into session_participants (session_id, user_id, mode) values (?, ?, 'LANE')
                    on conflict (session_id, user_id) do update set mode = 'LANE'
                    """).params(sessionId, toUserId).update();
            audit.record(workspaceId, userId, "session.handed_off", "session", sessionId,
                    Map.of("to", toUserId.toString(), "steps", steps));
            changed(workspaceId, userId, sessionId);
        });
        return card(sessionId);
    }

    public Card finish(UUID sessionId, UUID userId, int rowVersion) {
        UUID workspaceId = workspaceOf(sessionId);
        Role role = access.require(workspaceId, userId, Role.EDITOR);
        tx.executeWithoutResult(status -> {
            int updated = jdbc.sql("""
                    update sessions set status = 'DONE', ended_at = now(), row_version = row_version + 1
                    where id = ? and row_version = ? and status <> 'DONE' and (driver_id = ? or ?)
                    """).params(sessionId, rowVersion, userId, role == Role.OWNER).update();
            if (updated == 0) throw ApiException.conflict("Only the driver or an owner can finish the session, and it changed meanwhile");
            audit.record(workspaceId, userId, "session.finished", "session", sessionId, Map.of());
            changed(workspaceId, userId, sessionId);
        });
        return card(sessionId);
    }

    /**
     * A driver who loses edit access cannot keep paying for or steering the session: it waits for a takeover
     * (design §13.8). Runs after the membership change commits.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    void onAccessChanged(AccessChanged change) {
        if (change.role() != null && change.role().atLeast(Role.EDITOR)) return;
        List<UUID> stalled = jdbc.sql("""
                update sessions set status = 'AWAITING_TAKEOVER', row_version = row_version + 1
                where workspace_id = ? and driver_id = ? and status = 'ACTIVE' returning id
                """).params(change.workspaceId(), change.userId()).query(UUID.class).list();
        stalled.forEach(id -> events.publishEvent(WorkspaceEvent.of("SESSION_CHANGED", change.workspaceId(),
                change.userId(), Map.of("sessionId", id))));
    }

    UUID workspaceOf(UUID sessionId) {
        return jdbc.sql("select workspace_id from sessions where id = ?").param(sessionId).query(UUID.class)
                .optional().orElseThrow(() -> ApiException.notFound("Session"));
    }

    /** What a taking-over agent needs to resume: task, plan with owners, and the latest replies. */
    private String carryOver(UUID sessionId, Card before, String takerName, String guidance) {
        StringBuilder prompt = new StringBuilder();
        prompt.append(takerName).append(" is taking over this session from ").append(before.driverName())
                .append(". Continue the task where it stopped. Start by saying in one sentence where you resume.\n\n");
        prompt.append("Task: ").append(before.task()).append("\n");
        List<Plans.Step> steps = plans.steps(sessionId);
        if (!steps.isEmpty()) {
            prompt.append("\nPlan:\n").append(steps.stream()
                    .map(s -> s.position() + ". [" + s.status() + "] " + s.title()
                            + (s.ownerName() == null ? "" : " (" + s.ownerName() + ")"))
                    .collect(Collectors.joining("\n"))).append("\n");
        }
        List<String> recent = jdbc.sql("""
                select t.id from agent_turns t where t.session_id = ? order by t.started_at desc limit 1
                """).param(sessionId).query(UUID.class).list().stream()
                .flatMap(id -> turns.summary(id).stream()).toList();
        if (!recent.isEmpty()) prompt.append("\nLatest progress from the previous turn:\n").append(String.join("\n", recent)).append("\n");
        if (guidance != null && !guidance.isBlank()) prompt.append("\n").append(takerName).append(" adds: ").append(guidance.strip()).append("\n");
        return prompt.toString();
    }

    private void changed(UUID workspaceId, UUID actorId, UUID sessionId) {
        events.publishEvent(WorkspaceEvent.of("SESSION_CHANGED", workspaceId, actorId, Map.of("sessionId", sessionId)));
    }

    Card card(UUID sessionId) {
        record Row(UUID id, String task, String status, UUID driverId, String driverName, int rowVersion,
                Timestamp createdAt, Timestamp endedAt) {
        }
        Row row = jdbc.sql("""
                select s.id, s.task, s.status, s.driver_id, u.display_name, s.row_version, s.created_at, s.ended_at
                from sessions s join users u on u.id = s.driver_id where s.id = ?
                """).param(sessionId)
                .query((rs, n) -> new Row(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        rs.getObject(4, UUID.class), rs.getString(5), rs.getInt(6), rs.getTimestamp(7), rs.getTimestamp(8)))
                .optional().orElseThrow(() -> ApiException.notFound("Session"));
        List<Participant> participants = jdbc.sql("""
                select p.user_id, u.display_name, p.mode from session_participants p join users u on u.id = p.user_id
                where p.session_id = ? order by p.joined_at
                """).param(sessionId)
                .query((rs, n) -> new Participant(rs.getObject(1, UUID.class), rs.getString(2), Mode.valueOf(rs.getString(3))))
                .list();
        List<Plans.Step> steps = plans.steps(sessionId);
        List<String> files = jdbc.sql("""
                select distinct f.path from agent_turn_files tf join agent_turns t on t.id = tf.turn_id
                join files f on f.id = tf.file_id and f.deleted_at is null
                where t.session_id = ? order by f.path limit 20
                """).param(sessionId).query(String.class).list();
        int running = jdbc.sql("select count(*) from agent_turns where session_id = ? and status = 'RUNNING'")
                .param(sessionId).query(Integer.class).single();
        return new Card(row.id(), row.task(), row.status(), row.driverId(), row.driverName(), row.rowVersion(),
                participants, (int) steps.stream().filter(s -> s.status() == Plans.Status.DONE).count(), steps.size(),
                files, running, row.createdAt().toInstant(), row.endedAt() == null ? null : row.endedAt().toInstant());
    }
}
