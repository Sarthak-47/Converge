package dev.converge.api.agent;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import dev.converge.api.agent.AgentRunnerClient.History;
import dev.converge.api.agent.AgentRunnerClient.RevertFile;
import dev.converge.api.agent.AgentRunnerClient.SessionContext;
import dev.converge.api.agent.AgentRunnerClient.Sponsor;
import dev.converge.api.agent.AgentRunnerClient.StartTurn;
import dev.converge.api.common.ApiException;
import dev.converge.api.memory.TeamContext;
import dev.converge.api.realtime.WorkspaceEvent;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Agent turns (design §13): one sponsor per turn, paid with that member's own key; a lane transcript that
 * every member can watch; a cost ledger with a hard cap; and "Revert this turn".
 */
@Service
public class AgentTurns {

    /** Log lines carry the trace ID, which the runner continues (design §16.3). */
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(AgentTurns.class);

    public record Turn(UUID id, UUID sessionId, UUID laneUserId, UUID sponsorId, String sponsorName, String model, String status,
            String error, long costMicros, long costCapMicros, Instant startedAt, Instant endedAt, String revertStatus,
            boolean revertible, List<Map<String, Object>> events) {
    }

    static final Pattern SECRET = Pattern.compile("sk-ant-[A-Za-z0-9_\\-]{8,}");
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final ProviderKeys keys;
    private final TeamContext team;
    private final dev.converge.api.common.RateLimiter limits;
    private final dev.converge.api.common.ConvergeMetrics metrics;
    private final SecretBox box;
    private final AgentRunnerClient runner;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;
    private final JsonMapper json = JsonMapper.builder().build();
    private final String model;
    private final java.util.List<String> models;
    private final String effort;
    private final long costCapMicros;
    private final long dailyCapMicros;

    /** What a member's agents have spent in the last 24 hours, against their daily cap (design §13.5). */
    public record Spend(long spentMicros, long dailyCapMicros, long turnCapMicros) {
    }

    public AgentTurns(JdbcClient jdbc, WorkspaceAccess access, ProviderKeys keys, TeamContext team,
            dev.converge.api.common.RateLimiter limits, dev.converge.api.common.ConvergeMetrics metrics, SecretBox box,
            AgentRunnerClient runner, ApplicationEventPublisher events, TransactionTemplate tx,
            @Value("${converge.agent.model}") String model, @Value("${converge.agent.effort}") String effort,
            @Value("${converge.agent.models:claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5}") String choices,
            @Value("${converge.agent.cost-cap-micros}") long costCapMicros,
            @Value("${converge.agent.daily-cap-micros:20000000}") long dailyCapMicros) {
        this.dailyCapMicros = dailyCapMicros;
        this.jdbc = jdbc;
        this.access = access;
        this.keys = keys;
        this.team = team;
        this.limits = limits;
        this.metrics = metrics;
        this.box = box;
        this.runner = runner;
        this.events = events;
        this.tx = tx;
        this.model = model;
        java.util.List<String> allowed = new java.util.ArrayList<>(java.util.List.of(model));
        java.util.Arrays.stream(choices.split(",")).map(String::strip).filter(m -> !m.isEmpty() && !allowed.contains(m)).forEach(allowed::add);
        this.models = java.util.List.copyOf(allowed);
        this.effort = effort;
        this.costCapMicros = costCapMicros;
    }

    /**
     * Starts a turn in the member's own lane, paid with their own key (design §13.5). Within a session the
     * member joins as a lane if they were watching, and the runner gets the session's task so the agent can
     * read and update the plan.
     */
    public Turn start(UUID workspaceId, UUID sessionId, UUID userId, String displayName, String prompt) {
        return start(workspaceId, sessionId, userId, displayName, prompt, null);
    }

    /** The models members may choose per turn, the default first (design §13.4). */
    public java.util.List<String> models() {
        return models;
    }

    /**
     * As {@link #start(UUID, UUID, UUID, String, String)}, on a model the member chose from the allowed ones
     * (null for the default): a cheaper model for quick edits, the strongest for hard ones.
     */
    public Turn start(UUID workspaceId, UUID sessionId, UUID userId, String displayName, String prompt, String requestedModel) {
        String model = requestedModel == null || requestedModel.isBlank() ? this.model : requestedModel.strip();
        if (!models.contains(model)) throw ApiException.badRequest("Choose one of the available models: " + String.join(", ", models));
        access.require(workspaceId, userId, Role.EDITOR);
        limits.check(dev.converge.api.common.RateLimiter.AGENT_PROMPT, userId.toString());
        String task = sessionId == null ? null : sessionTask(workspaceId, sessionId);
        String apiKey = keys.reveal(userId).orElseThrow(() -> ApiException.conflict(
                "Add your Anthropic API key before prompting your agent"));
        // A turn may spend at most the per-turn cap and what is left of the member's daily cap; reaching it
        // mid-turn ends the turn as BUDGET_EXCEEDED, which puts a session up for takeover.
        long spent = spentToday(userId);
        if (spent >= dailyCapMicros) {
            throw ApiException.conflict(String.format(
                    "Your agents have spent $%.2f in the last 24 hours, your daily cap; someone else can take over the session",
                    dailyCapMicros / 1e6));
        }
        long turnCap = Math.min(costCapMicros, dailyCapMicros - spent);
        UUID turnId = UUID.randomUUID();
        List<History> history = history(workspaceId, sessionId, userId);
        // Memory, overlaps and held ranges; looked up before the transaction because they fail open.
        TeamContext.Context context = team.forTurn(workspaceId, sessionId);
        try {
            tx.executeWithoutResult(status -> {
                jdbc.sql("""
                        insert into agent_turns (id, workspace_id, session_id, lane_user_id, sponsor_id, model, status, cost_cap_micros)
                        values (?, ?, ?, ?, ?, ?, 'RUNNING', ?)
                        """)
                        .params(turnId, workspaceId, sessionId, userId, userId, model, turnCap)
                        .update();
                if (sessionId != null) {
                    jdbc.sql("""
                            insert into session_participants (session_id, user_id, mode) values (?, ?, 'LANE')
                            on conflict (session_id, user_id) do update set mode = 'LANE'
                            """).params(sessionId, userId).update();
                    // The driver prompting again (with a new key or after the cap) resumes a stalled session.
                    jdbc.sql("""
                            update sessions set status = 'ACTIVE', row_version = row_version + 1
                            where id = ? and driver_id = ? and status = 'AWAITING_TAKEOVER'
                            """).params(sessionId, userId).update();
                    publishSession(workspaceId, userId, sessionId);
                }
                append(turnId, workspaceId, userId, Map.of("kind", "prompt", "text", prompt));
                if (context.stale()) append(turnId, workspaceId, userId, Map.of("kind", "note", "text", context.text()));
                publish("AGENT_TURN_STARTED", workspaceId, userId, turnId);
            });
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("Your agent is already working on a turn; stop it or wait for it to finish");
        }
        try {
            log.info("Agent turn {} started in workspace {} on the sponsor's key", turnId, workspaceId);
            runner.start(new StartTurn(turnId, workspaceId, new Sponsor(userId, displayName), apiKey, model, effort,
                    prompt, history, turnCap, sessionId == null ? null : new SessionContext(sessionId, task),
                    context.text().isBlank() ? null : context.text()));
        } catch (ApiException e) {
            finish(turnId, "FAILED", "The agent runner is unavailable");
            throw e;
        }
        return turn(workspaceId, turnId);
    }

    /** What the member's agents spent in the last 24 hours, against their caps. */
    public Spend spend(UUID userId) {
        return new Spend(spentToday(userId), dailyCapMicros, costCapMicros);
    }

    private long spentToday(UUID userId) {
        return jdbc.sql("select coalesce(sum(cost_micros), 0) from agent_turns where sponsor_id = ? and started_at > now() - interval '24 hours'")
                .param(userId).query(Long.class).single();
    }

    /** Refuses early when a member has no key, before anything else changes (for example a takeover). */
    public void requireKey(UUID userId) {
        if (keys.reveal(userId).isEmpty()) {
            throw ApiException.conflict("Add your Anthropic API key before prompting your agent");
        }
    }

    /** Stops a running turn for a takeover, whoever its sponsor is (design §13.8). */
    public void stop(UUID turnId, String reason) {
        if (!runner.cancel(turnId)) finish(turnId, "CANCELLED", reason);
    }

    /** The agent's latest replies in a turn, for carrying context over to whoever continues the work. */
    public List<String> summary(UUID turnId) {
        List<String> replies = transcript(turnId).stream()
                .filter(e -> "text".equals(e.get("kind")))
                .map(e -> String.valueOf(e.get("text")))
                .toList();
        return replies.subList(Math.max(0, replies.size() - 3), replies.size());
    }

    /** The newest turns of a session (or, without one, of the whole workspace), oldest first. */
    public List<Turn> list(UUID workspaceId, UUID sessionId, UUID userId) {
        access.require(workspaceId, userId, Role.VIEWER);
        List<UUID> ids = jdbc.sql("""
                select id from agent_turns where workspace_id = ? and (cast(? as uuid) is null or session_id = ?)
                order by started_at desc limit 50
                """)
                .params(workspaceId, sessionId, sessionId).query(UUID.class).list();
        return ids.reversed().stream().map(id -> turn(workspaceId, id)).toList();
    }

    /** Only the sponsor steers a running turn, because it spends their key (design §13.6). */
    public Turn cancel(UUID workspaceId, UUID turnId, UUID userId) {
        access.require(workspaceId, userId, Role.EDITOR);
        TurnRow row = row(turnId);
        if (!row.workspaceId().equals(workspaceId)) throw ApiException.notFound("Turn");
        if (!row.sponsorId().equals(userId)) throw ApiException.forbidden("Only the turn's sponsor can stop it");
        if (!"RUNNING".equals(row.status())) return turn(workspaceId, turnId);
        if (!runner.cancel(turnId)) {
            finish(turnId, "CANCELLED", "The agent runner no longer had this turn");
        }
        return turn(workspaceId, turnId);
    }

    /**
     * Guidance for a running turn (design §13.8). Only the sponsor steers, because it spends their key; if the
     * turn has already ended, the caller gets a conflict and the client returns the text to the composer.
     */
    public Turn steer(UUID workspaceId, UUID turnId, UUID userId, String text) {
        access.require(workspaceId, userId, Role.EDITOR);
        TurnRow row = row(turnId);
        if (!row.workspaceId().equals(workspaceId)) throw ApiException.notFound("Turn");
        if (!row.sponsorId().equals(userId)) throw ApiException.forbidden("Only the turn's sponsor can steer it");
        if (!"RUNNING".equals(row.status()) || !runner.steer(turnId, text)) {
            throw ApiException.conflict("The turn has already ended; send this as a new prompt instead");
        }
        tx.executeWithoutResult(status -> append(turnId, workspaceId, userId, Map.of("kind", "steer", "text", text)));
        return turn(workspaceId, turnId);
    }

    /**
     * Undoes one finished turn's edits without touching anyone else's (design §13.2). The revert is claimed by
     * compare-and-set, so two clicks cannot revert twice.
     */
    public Turn revert(UUID workspaceId, UUID turnId, UUID userId, String displayName) {
        access.require(workspaceId, userId, Role.EDITOR);
        TurnRow row = row(turnId);
        if (!row.workspaceId().equals(workspaceId)) throw ApiException.notFound("Turn");
        int claimed = jdbc.sql("""
                update agent_turns set revert_status = 'REVERTING', reverted_by = ?
                where id = ? and status <> 'RUNNING' and revert_status is null
                  and exists (select 1 from agent_turn_files f where f.turn_id = agent_turns.id)
                """).params(userId, turnId).update();
        if (claimed == 0) throw ApiException.conflict("This turn is running, has no edits, or was already reverted");
        try {
            List<RevertFile> files = jdbc.sql("""
                    select f.file_id, f.doc_state, f.undo::text as undo from agent_turn_files f
                    join files on files.id = f.file_id and files.deleted_at is null
                    where f.turn_id = ?
                    """)
                    .param(turnId)
                    .query((rs, n) -> new RevertFile(rs.getObject("file_id", UUID.class),
                            Base64.getEncoder().encodeToString(rs.getBytes("doc_state")),
                            json.readValue(rs.getString("undo"), MAP)))
                    .list();
            runner.revert(turnId, displayName, files);
        } catch (RuntimeException e) {
            jdbc.sql("update agent_turns set revert_status = null, reverted_by = null where id = ?").param(turnId).update();
            throw e;
        }
        tx.executeWithoutResult(status -> {
            jdbc.sql("update agent_turns set revert_status = 'REVERTED', reverted_at = now() where id = ?")
                    .param(turnId).update();
            publish("AGENT_TURN_REVERTED", workspaceId, userId, turnId);
        });
        return turn(workspaceId, turnId);
    }

    // ---- Called by the runner, through AgentInternalController -----------------------------------------

    record TurnRow(UUID id, UUID workspaceId, UUID sessionId, UUID sponsorId, String status, String revertStatus,
            UUID revertedBy) {
    }

    TurnRow row(UUID turnId) {
        return jdbc.sql("select id, workspace_id, session_id, sponsor_id, status, revert_status, reverted_by from agent_turns where id = ?")
                .param(turnId)
                .query((rs, n) -> new TurnRow(rs.getObject("id", UUID.class), rs.getObject("workspace_id", UUID.class),
                        rs.getObject("session_id", UUID.class), rs.getObject("sponsor_id", UUID.class), rs.getString("status"), rs.getString("revert_status"),
                        rs.getObject("reverted_by", UUID.class)))
                .optional()
                .orElseThrow(() -> ApiException.notFound("Turn"));
    }

    /**
     * The person a runner call acts as: the sponsor while the turn runs, or whoever is reverting it. Their role
     * is checked on every call, so removing a member stops their agent at its next tool call.
     */
    UUID actingUser(TurnRow row) {
        UUID user;
        if ("RUNNING".equals(row.status())) {
            user = row.sponsorId();
        } else if ("REVERTING".equals(row.revertStatus())) {
            user = row.revertedBy();
        } else {
            throw ApiException.conflict("The turn is not running");
        }
        try {
            access.require(row.workspaceId(), user, Role.EDITOR);
        } catch (ApiException e) {
            throw ApiException.forbidden("The member behind this turn can no longer edit this workspace");
        }
        return user;
    }

    /** What other parts of the API may know about a running turn. */
    public record TurnRef(UUID workspaceId, UUID sessionId, UUID sponsorId) {
    }

    /** A running turn whose sponsor may still edit, or a conflict/forbidden error. */
    public TurnRef runningRef(UUID turnId) {
        TurnRow row = running(turnId);
        return new TurnRef(row.workspaceId(), row.sessionId(), row.sponsorId());
    }

    /** Adds a transcript event to a running turn, within the caller's transaction. */
    public void recordEvent(UUID turnId, Map<String, Object> event) {
        TurnRow row = running(turnId);
        append(turnId, row.workspaceId(), row.sponsorId(), event);
    }

    TurnRow running(UUID turnId) {
        TurnRow row = row(turnId);
        if (!"RUNNING".equals(row.status())) throw ApiException.conflict("The turn is not running");
        actingUser(row);
        return row;
    }

    void event(UUID turnId, Map<String, Object> event) {
        TurnRow row = running(turnId);
        tx.executeWithoutResult(status -> append(turnId, row.workspaceId(), row.sponsorId(), event));
    }

    long usage(UUID turnId, long input, long output, long cacheRead, long cacheWrite, long cost) {
        running(turnId);
        return jdbc.sql("""
                update agent_turns set input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
                    cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?,
                    cost_micros = cost_micros + ?
                where id = ? returning cost_micros
                """)
                .params(input, output, cacheRead, cacheWrite, cost, turnId)
                .query(Long.class)
                .single();
    }

    void saveRevertState(UUID turnId, UUID fileId, byte[] state, Map<String, Object> undo) {
        TurnRow row = running(turnId);
        int inWorkspace = jdbc.sql("select count(*) from files where id = ? and workspace_id = ?")
                .params(fileId, row.workspaceId()).query(Integer.class).single();
        if (inWorkspace == 0) throw ApiException.notFound("File");
        jdbc.sql("""
                insert into agent_turn_files (turn_id, file_id, doc_state, undo) values (?, ?, ?, cast(? as jsonb))
                on conflict (turn_id, file_id) do update set doc_state = excluded.doc_state, undo = excluded.undo
                """)
                .params(turnId, fileId, state, json.writeValueAsString(undo))
                .update();
    }

    /**
     * Ends a turn. When the session's driver can no longer pay (cost cap reached, key rejected), the session
     * waits for a takeover instead of failing silently (design §13.5, §13.8).
     */
    void finish(UUID turnId, String status, String error, String code) {
        TurnRow row = row(turnId);
        tx.executeWithoutResult(t -> {
            int updated = jdbc.sql("update agent_turns set status = ?, error = ?, ended_at = now() where id = ? and status = 'RUNNING'")
                    .params(status, error == null ? null : redact(error), turnId)
                    .update();
            if (updated == 0) return;
            publish("AGENT_TURN_FINISHED", row.workspaceId(), row.sponsorId(), turnId);
            record Cost(String model, long micros) {
            }
            Cost cost = jdbc.sql("select model, cost_micros from agent_turns where id = ?").param(turnId)
                    .query((rs, n) -> new Cost(rs.getString(1), rs.getLong(2))).single();
            metrics.turnFinished(status, cost.model(), cost.micros());
            // A card nobody answered before the turn ended can no longer authorize anything.
            int expired = jdbc.sql("""
                    update approvals set status = 'EXPIRED', row_version = row_version + 1
                    where turn_id = ? and status = 'PENDING'
                    """).param(turnId).update();
            if (expired > 0) {
                events.publishEvent(WorkspaceEvent.of("APPROVAL_CHANGED", row.workspaceId(), row.sponsorId(), Map.of("turnId", turnId)));
            }
            boolean cannotPay = "BUDGET_EXCEEDED".equals(status) || "KEY_REJECTED".equals(code);
            if (row.sessionId() != null && cannotPay) {
                int stalled = jdbc.sql("""
                        update sessions set status = 'AWAITING_TAKEOVER', row_version = row_version + 1
                        where id = ? and driver_id = ? and status = 'ACTIVE'
                        """).params(row.sessionId(), row.sponsorId()).update();
                if (stalled > 0) publishSession(row.workspaceId(), row.sponsorId(), row.sessionId());
            }
        });
    }

    void finish(UUID turnId, String status, String error) {
        finish(turnId, status, error, null);
    }

    // ---- Helpers ---------------------------------------------------------------------------------------

    static String redact(String text) {
        return SECRET.matcher(text).replaceAll("sk-ant-…redacted");
    }

    private void append(UUID turnId, UUID workspaceId, UUID actorId, Map<String, Object> event) {
        Map<String, Object> clean = new LinkedHashMap<>();
        event.forEach((key, value) -> clean.put(key, value instanceof String s ? redact(s) : value));
        int seq = jdbc.sql("select coalesce(max(seq), 0) + 1 from transcript_chunks where turn_id = ?")
                .param(turnId).query(Integer.class).single();
        String kind = String.valueOf(clean.getOrDefault("kind", "text"));
        jdbc.sql("insert into transcript_chunks (turn_id, seq, kind, ciphertext) values (?, ?, ?, ?)")
                .params(turnId, seq, kind, box.seal(json.writeValueAsString(clean), chunkContext(turnId, seq)))
                .update();
        clean.put("seq", seq);
        clean.put("turnId", turnId);
        events.publishEvent(WorkspaceEvent.of("AGENT_TURN_EVENT", workspaceId, actorId, clean));
    }

    private void publishSession(UUID workspaceId, UUID actorId, UUID sessionId) {
        events.publishEvent(WorkspaceEvent.of("SESSION_CHANGED", workspaceId, actorId, Map.of("sessionId", sessionId)));
    }

    private String sessionTask(UUID workspaceId, UUID sessionId) {
        record S(String task, String status) {
        }
        S session = jdbc.sql("select task, status from sessions where id = ? and workspace_id = ?")
                .params(sessionId, workspaceId)
                .query((rs, n) -> new S(rs.getString(1), rs.getString(2)))
                .optional().orElseThrow(() -> ApiException.notFound("Session"));
        if ("DONE".equals(session.status())) throw ApiException.conflict("This session is finished");
        return session.task();
    }

    private void publish(String type, UUID workspaceId, UUID actorId, UUID turnId) {
        events.publishEvent(WorkspaceEvent.of(type, workspaceId, actorId, Map.of("turnId", turnId)));
    }

    private static String chunkContext(UUID turnId, int seq) {
        return "transcript:" + turnId + ":" + seq;
    }

    private List<Map<String, Object>> transcript(UUID turnId) {
        return jdbc.sql("select seq, ciphertext from transcript_chunks where turn_id = ? order by seq")
                .param(turnId)
                .query((rs, n) -> {
                    int seq = rs.getInt("seq");
                    Map<String, Object> event = new LinkedHashMap<>(
                            json.readValue(box.open(rs.getBytes("ciphertext"), chunkContext(turnId, seq)), MAP));
                    event.put("seq", seq);
                    return event;
                })
                .list();
    }

    /** The last few finished exchanges in a lane, so a follow-up prompt has context. */
    private List<History> history(UUID workspaceId, UUID sessionId, UUID laneUserId) {
        List<UUID> ids = jdbc.sql("""
                select id from agent_turns where workspace_id = ? and lane_user_id = ? and status <> 'RUNNING'
                  and session_id is not distinct from cast(? as uuid)
                order by started_at desc limit 5
                """).params(workspaceId, laneUserId, sessionId).query(UUID.class).list();
        List<History> history = new ArrayList<>();
        for (UUID id : ids.reversed()) {
            String prompt = "";
            String reply = "";
            for (Map<String, Object> event : transcript(id)) {
                if ("prompt".equals(event.get("kind"))) prompt = String.valueOf(event.get("text"));
                if ("text".equals(event.get("kind"))) reply = String.valueOf(event.get("text"));
            }
            if (!prompt.isBlank()) history.add(new History(prompt, reply));
        }
        return history;
    }

    private Turn turn(UUID workspaceId, UUID turnId) {
        Turn turn = jdbc.sql("""
                select t.*, u.display_name,
                       exists (select 1 from agent_turn_files f where f.turn_id = t.id) as has_edits
                from agent_turns t join users u on u.id = t.sponsor_id
                where t.id = ? and t.workspace_id = ?
                """)
                .params(turnId, workspaceId)
                .query((rs, n) -> new Turn(turnId, rs.getObject("session_id", UUID.class), rs.getObject("lane_user_id", UUID.class),
                        rs.getObject("sponsor_id", UUID.class), rs.getString("display_name"), rs.getString("model"),
                        rs.getString("status"), rs.getString("error"), rs.getLong("cost_micros"),
                        rs.getLong("cost_cap_micros"), toInstant(rs.getTimestamp("started_at")),
                        toInstant(rs.getTimestamp("ended_at")), rs.getString("revert_status"),
                        rs.getBoolean("has_edits") && !"RUNNING".equals(rs.getString("status"))
                                && rs.getString("revert_status") == null,
                        List.of()))
                .optional()
                .orElseThrow(() -> ApiException.notFound("Turn"));
        return new Turn(turn.id(), turn.sessionId(), turn.laneUserId(), turn.sponsorId(), turn.sponsorName(), turn.model(), turn.status(),
                turn.error(), turn.costMicros(), turn.costCapMicros(), turn.startedAt(), turn.endedAt(),
                turn.revertStatus(), turn.revertible(), transcript(turnId));
    }

    private static Instant toInstant(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }
}
