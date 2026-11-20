package dev.converge.api.session;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import dev.converge.api.agent.AgentTurns;
import dev.converge.api.agent.AgentTurns.Turn;
import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.WorkspaceEvent;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Comments (design §13.9) attach to a file range, an agent turn or a plan step. File anchors are Yjs relative
 * positions chosen by the client, so they follow the text through every edit; the client labels a comment
 * outdated when its anchored text is gone. A comment can become a plan step or a prompt to the commenter's
 * own agent and stays linked to what it caused. Resolving never deletes.
 */
@Service
public class Comments {

    public enum Target { FILE_RANGE, TURN, PLAN_STEP }

    public record Comment(UUID id, UUID sessionId, Target targetKind, UUID fileId, UUID turnId, UUID stepId,
            Map<String, Object> anchor, String quote, String body, String status, UUID createdBy, String authorName,
            Instant createdAt, UUID resolvedBy, UUID causedStepId, UUID causedTurnId) {
    }

    public record NewComment(UUID sessionId, Target targetKind, UUID fileId, UUID turnId, UUID stepId,
            Map<String, Object> anchor, String quote, String body) {
    }

    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final Plans plans;
    private final AgentTurns turns;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;
    private final JsonMapper json = JsonMapper.builder().build();
    private final dev.converge.api.common.RateLimiter limits;

    public Comments(JdbcClient jdbc, WorkspaceAccess access, Plans plans, AgentTurns turns,
            ApplicationEventPublisher events, TransactionTemplate tx, dev.converge.api.common.RateLimiter limits) {
        this.limits = limits;
        this.jdbc = jdbc;
        this.access = access;
        this.plans = plans;
        this.turns = turns;
        this.events = events;
        this.tx = tx;
    }

    public Comment create(UUID workspaceId, UUID userId, NewComment input) {
        access.require(workspaceId, userId, Role.COMMENTER);
        limits.check(dev.converge.api.common.RateLimiter.WRITE, userId.toString());
        if (input.sessionId() != null) requireIn("sessions", input.sessionId(), workspaceId);
        switch (input.targetKind()) {
            case FILE_RANGE -> {
                if (input.fileId() == null || input.anchor() == null) throw ApiException.badRequest("A file comment needs a file and an anchor");
                requireIn("files", input.fileId(), workspaceId);
                if (json.writeValueAsString(input.anchor()).length() > 4000) throw ApiException.badRequest("Anchor too large");
            }
            case TURN -> {
                if (input.turnId() == null) throw ApiException.badRequest("A turn comment needs a turn");
                requireIn("agent_turns", input.turnId(), workspaceId);
            }
            case PLAN_STEP -> {
                if (input.stepId() == null) throw ApiException.badRequest("A plan comment needs a step");
                int found = jdbc.sql("select count(*) from plan_steps p join sessions s on s.id = p.session_id where p.id = ? and s.workspace_id = ?")
                        .params(input.stepId(), workspaceId).query(Integer.class).single();
                if (found == 0) throw ApiException.notFound("Step");
            }
        }
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> {
            jdbc.sql("""
                    insert into comments (id, workspace_id, session_id, target_kind, file_id, turn_id, step_id, anchor, quote, body, created_by)
                    values (?, ?, ?, ?, ?, ?, ?, cast(? as jsonb), ?, ?, ?)
                    """)
                    .params(id, workspaceId, input.sessionId(), input.targetKind().name(),
                            input.targetKind() == Target.FILE_RANGE ? input.fileId() : null,
                            input.targetKind() == Target.TURN ? input.turnId() : null,
                            input.targetKind() == Target.PLAN_STEP ? input.stepId() : null,
                            input.targetKind() == Target.FILE_RANGE ? json.writeValueAsString(input.anchor()) : null,
                            input.quote() == null ? null : input.quote().substring(0, Math.min(2000, input.quote().length())),
                            input.body().strip(), userId)
                    .update();
            changed(workspaceId, userId, id);
        });
        return find(id);
    }

    /** Comments in a workspace, optionally for one file or one session. */
    public List<Comment> list(UUID workspaceId, UUID userId, UUID fileId, UUID sessionId) {
        access.require(workspaceId, userId, Role.VIEWER);
        return jdbc.sql("""
                select c.*, u.display_name from comments c join users u on u.id = c.created_by
                where c.workspace_id = ? and (cast(? as uuid) is null or c.file_id = ?)
                  and (cast(? as uuid) is null or c.session_id = ?)
                order by c.created_at limit 500
                """)
                .params(workspaceId, fileId, fileId, sessionId, sessionId)
                .query((rs, n) -> map(rs))
                .list();
    }

    public Comment resolve(UUID workspaceId, UUID commentId, UUID userId, boolean resolved) {
        access.require(workspaceId, userId, Role.COMMENTER);
        Comment comment = inWorkspace(workspaceId, commentId);
        tx.executeWithoutResult(status -> {
            jdbc.sql("update comments set status = ?, resolved_by = ?, resolved_at = case when ? then now() end where id = ?")
                    .params(resolved ? "RESOLVED" : "OPEN", resolved ? userId : null, resolved, comment.id())
                    .update();
            changed(workspaceId, userId, commentId);
        });
        return find(commentId);
    }

    /** Turns a comment into a plan step in its session, linked back to the comment. */
    public Comment toStep(UUID workspaceId, UUID commentId, UUID userId) {
        access.require(workspaceId, userId, Role.EDITOR);
        Comment comment = inWorkspace(workspaceId, commentId);
        if (comment.sessionId() == null) throw ApiException.badRequest("Only comments in a session can become plan steps");
        if (comment.causedStepId() != null) throw ApiException.conflict("This comment already became a plan step");
        String title = comment.body().length() > 300 ? comment.body().substring(0, 297) + "…" : comment.body();
        List<Plans.Step> steps = plans.add(comment.sessionId(), List.of(title), null, userId);
        UUID stepId = steps.getLast().id();
        jdbc.sql("update comments set caused_step_id = ? where id = ?").params(stepId, commentId).update();
        changed(workspaceId, userId, commentId);
        return find(commentId);
    }

    /** Sends a comment to the commenter's own agent as a prompt, linked back to the comment. */
    public Turn toPrompt(UUID workspaceId, UUID commentId, UUID userId, String displayName) {
        Comment comment = inWorkspace(workspaceId, commentId);
        if (!comment.createdBy().equals(userId)) throw ApiException.forbidden("Only the comment's author can send it to their agent");
        if (comment.causedTurnId() != null) throw ApiException.conflict("This comment was already sent to an agent");
        StringBuilder prompt = new StringBuilder(comment.body());
        if (comment.targetKind() == Target.FILE_RANGE) {
            String path = jdbc.sql("select path from files where id = ?").param(comment.fileId()).query(String.class).optional().orElse("a file");
            prompt.append("\n\nThis is about ").append(path);
            if (comment.quote() != null && !comment.quote().isBlank()) prompt.append(", at:\n").append(comment.quote());
        }
        Turn turn = turns.start(workspaceId, comment.sessionId(), userId, displayName, prompt.toString());
        jdbc.sql("update comments set caused_turn_id = ? where id = ?").params(turn.id(), commentId).update();
        changed(workspaceId, userId, commentId);
        return turn;
    }

    private void requireIn(String table, UUID id, UUID workspaceId) {
        int found = jdbc.sql("select count(*) from " + table + " where id = ? and workspace_id = ?")
                .params(id, workspaceId).query(Integer.class).single();
        if (found == 0) throw ApiException.notFound("Target");
    }

    private Comment inWorkspace(UUID workspaceId, UUID commentId) {
        Comment comment = find(commentId);
        int found = jdbc.sql("select count(*) from comments where id = ? and workspace_id = ?")
                .params(commentId, workspaceId).query(Integer.class).single();
        if (found == 0) throw ApiException.notFound("Comment");
        return comment;
    }

    private Comment find(UUID commentId) {
        return jdbc.sql("select c.*, u.display_name from comments c join users u on u.id = c.created_by where c.id = ?")
                .param(commentId).query((rs, n) -> map(rs)).optional()
                .orElseThrow(() -> ApiException.notFound("Comment"));
    }

    private Comment map(java.sql.ResultSet rs) throws java.sql.SQLException {
        String anchor = rs.getString("anchor");
        return new Comment(rs.getObject("id", UUID.class), rs.getObject("session_id", UUID.class),
                Target.valueOf(rs.getString("target_kind")), rs.getObject("file_id", UUID.class),
                rs.getObject("turn_id", UUID.class), rs.getObject("step_id", UUID.class),
                anchor == null ? null : json.readValue(anchor, MAP), rs.getString("quote"), rs.getString("body"),
                rs.getString("status"), rs.getObject("created_by", UUID.class), rs.getString("display_name"),
                rs.getTimestamp("created_at").toInstant(), rs.getObject("resolved_by", UUID.class),
                rs.getObject("caused_step_id", UUID.class), rs.getObject("caused_turn_id", UUID.class));
    }

    private void changed(UUID workspaceId, UUID actorId, UUID commentId) {
        events.publishEvent(WorkspaceEvent.of("COMMENT_CHANGED", workspaceId, actorId, Map.of("commentId", commentId)));
    }
}
