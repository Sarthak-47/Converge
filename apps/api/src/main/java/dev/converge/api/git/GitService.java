package dev.converge.api.git;

import java.net.URI;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import dev.converge.api.agent.SecretBox;
import dev.converge.api.audit.AuditLog;
import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.CollabClient;
import dev.converge.api.realtime.WorkspaceEvent;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Server-side Git for browser members (design §10): connect a GitHub repository, then push the workspace as a
 * branch or open a pull request from a session. Operations are asynchronous jobs run by the worker, which
 * writes the stored text of the documents into its checkout at commit time (design §10.1). Desktop members
 * commit and push in their own checkout instead (design §12.8).
 */
@Service
public class GitService {

    public record Repository(String remoteUrl, String defaultBranch, String owner, String repo, String credentialHint,
            String connectedByName, Instant updatedAt) {
    }

    public record Operation(UUID id, UUID sessionId, String type, String status, String requesterName,
            Map<String, Object> params, Map<String, Object> result, String error, String log, Instant createdAt,
            Instant endedAt) {
    }

    /** github.com/owner/repo(.git), or any https host when the deployment allows it (GitHub Enterprise, tests). */
    private static final Pattern REMOTE = Pattern.compile("^(https?)://([A-Za-z0-9.:-]+)/([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100}?)(?:\\.git)?/?$");
    private static final Pattern BRANCH = Pattern.compile("^(?!.*\\.\\.)(?!.*//)(?!/)(?!.*/$)(?!.*\\.lock$)[A-Za-z0-9._/-]{1,100}$");
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final SecretBox box;
    private final CollabClient collab;
    private final AuditLog audit;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;
    private final boolean allowInsecureRemotes;
    private final JsonMapper json = JsonMapper.builder().build();

    public GitService(JdbcClient jdbc, WorkspaceAccess access, SecretBox box, CollabClient collab, AuditLog audit,
            ApplicationEventPublisher events, TransactionTemplate tx,
            @Value("${converge.git.allow-insecure-remotes:false}") boolean allowInsecureRemotes) {
        this.jdbc = jdbc;
        this.access = access;
        this.box = box;
        this.collab = collab;
        this.audit = audit;
        this.events = events;
        this.tx = tx;
        this.allowInsecureRemotes = allowInsecureRemotes;
    }

    // ---- Repository -----------------------------------------------------------------------------------

    public Repository connect(UUID workspaceId, UUID userId, String remoteUrl, String defaultBranch, String token) {
        access.require(workspaceId, userId, Role.OWNER);
        Matcher remote = REMOTE.matcher(remoteUrl == null ? "" : remoteUrl.strip());
        if (!remote.matches()) throw ApiException.badRequest("Use the repository's https URL, e.g. https://github.com/owner/repo.git");
        if (!"https".equals(remote.group(1)) && !allowInsecureRemotes) throw ApiException.badRequest("Only https remotes are allowed");
        String branch = defaultBranch == null || defaultBranch.isBlank() ? "main" : defaultBranch.strip();
        requireBranch(branch);
        if (token == null || token.strip().length() < 8 || token.strip().chars().anyMatch(Character::isWhitespace)) {
            throw ApiException.badRequest("Add a token that can push branches and open pull requests");
        }
        String secret = token.strip();
        String hint = "…" + secret.substring(secret.length() - 4);
        String url = URI.create(remote.group(0)).toString();
        tx.executeWithoutResult(status -> {
            jdbc.sql("""
                    insert into git_repositories (workspace_id, remote_url, default_branch, owner, repo, credential, credential_hint, connected_by)
                    values (?, ?, ?, ?, ?, ?, ?, ?)
                    on conflict (workspace_id) do update set remote_url = excluded.remote_url,
                        default_branch = excluded.default_branch, owner = excluded.owner, repo = excluded.repo,
                        credential = excluded.credential, credential_hint = excluded.credential_hint,
                        connected_by = excluded.connected_by, updated_at = now()
                    """)
                    .params(workspaceId, url, branch, remote.group(3), remote.group(4),
                            box.seal(secret, credentialContext(workspaceId)), hint, userId)
                    .update();
            audit.record(workspaceId, userId, "git.connected", "workspace", workspaceId, Map.of("remote", url));
            changed(workspaceId, userId, Map.of());
        });
        return repository(workspaceId, userId).orElseThrow();
    }

    public java.util.Optional<Repository> repository(UUID workspaceId, UUID userId) {
        access.require(workspaceId, userId, Role.VIEWER);
        return jdbc.sql("""
                select g.*, u.display_name from git_repositories g join users u on u.id = g.connected_by
                where g.workspace_id = ?
                """).param(workspaceId)
                .query((rs, n) -> new Repository(rs.getString("remote_url"), rs.getString("default_branch"),
                        rs.getString("owner"), rs.getString("repo"), rs.getString("credential_hint"),
                        rs.getString("display_name"), rs.getTimestamp("updated_at").toInstant()))
                .optional();
    }

    public void disconnect(UUID workspaceId, UUID userId) {
        access.require(workspaceId, userId, Role.OWNER);
        tx.executeWithoutResult(status -> {
            jdbc.sql("delete from git_repositories where workspace_id = ?").param(workspaceId).update();
            audit.record(workspaceId, userId, "git.disconnected", "workspace", workspaceId, Map.of());
            changed(workspaceId, userId, Map.of());
        });
    }

    // ---- Operations -----------------------------------------------------------------------------------

    /**
     * Opens a pull request for a session (design §10, Phase 12 exit): the workspace's current text on a
     * branch named after the session, titled with its task and described with its plan.
     */
    public Operation pullRequest(UUID sessionId, UUID userId, String idempotencyKey, String title, String body) {
        record S(UUID workspaceId, String task, UUID driverId) {
        }
        S session = jdbc.sql("select workspace_id, task, driver_id from sessions where id = ?").param(sessionId)
                .query((rs, n) -> new S(rs.getObject(1, UUID.class), rs.getString(2), rs.getObject(3, UUID.class)))
                .optional().orElseThrow(() -> ApiException.notFound("Session"));
        Role role = access.require(session.workspaceId(), userId, Role.EDITOR);
        if (!userId.equals(session.driverId()) && role != Role.OWNER) {
            throw ApiException.forbidden("Only the session's driver or an owner opens its pull request");
        }
        String branch = "converge/" + slug(session.task()) + "-" + sessionId.toString().substring(0, 8);
        String prTitle = title == null || title.isBlank() ? session.task() : title.strip();
        String prBody = body == null || body.isBlank() ? describe(sessionId, session.task()) : body.strip();
        return enqueue(session.workspaceId(), sessionId, userId, "PULL_REQUEST", idempotencyKey,
                Map.of("branch", branch, "title", truncate(prTitle, 200), "body", truncate(prBody, 20_000),
                        "message", truncate(prTitle, 200)));
    }

    /** Pushes the workspace's current text as a branch, without a pull request. */
    public Operation pushBranch(UUID workspaceId, UUID userId, String idempotencyKey, String branch, String message) {
        access.require(workspaceId, userId, Role.EDITOR);
        requireBranch(branch);
        if (message == null || message.isBlank()) throw ApiException.badRequest("A commit needs a message");
        return enqueue(workspaceId, null, userId, "PUSH_BRANCH", idempotencyKey,
                Map.of("branch", branch, "message", truncate(message.strip(), 2000)));
    }

    public List<Operation> operations(UUID workspaceId, UUID userId, UUID sessionId) {
        access.require(workspaceId, userId, Role.VIEWER);
        return jdbc.sql("""
                select id from git_operations where workspace_id = ? and (cast(? as uuid) is null or session_id = ?)
                order by created_at desc limit 50
                """).params(workspaceId, sessionId, sessionId).query(UUID.class).list()
                .stream().map(this::operation).toList();
    }

    // ---- Executor -----------------------------------------------------------------------------------

    void notifyChanged(UUID operationId) {
        UUID workspaceId = jdbc.sql("select workspace_id from git_operations where id = ?").param(operationId)
                .query(UUID.class).optional().orElseThrow(() -> ApiException.notFound("Operation"));
        changed(workspaceId, null, Map.of("operationId", operationId));
    }

    // ---- Helpers --------------------------------------------------------------------------------------

    private Operation enqueue(UUID workspaceId, UUID sessionId, UUID userId, String type, String idempotencyKey,
            Map<String, Object> params) {
        if (idempotencyKey == null || idempotencyKey.isBlank() || idempotencyKey.length() > 100) {
            throw ApiException.badRequest("An idempotency key is required");
        }
        int connected = jdbc.sql("select count(*) from git_repositories where workspace_id = ?").param(workspaceId)
                .query(Integer.class).single();
        if (connected == 0) throw ApiException.conflict("Connect a GitHub repository to this workspace first");
        // A retried request returns the operation it already started (design §15.3).
        var existing = jdbc.sql("select id from git_operations where workspace_id = ? and idempotency_key = ?")
                .params(workspaceId, idempotencyKey).query(UUID.class).optional();
        if (existing.isPresent()) return operation(existing.get());
        flushWorkspace(workspaceId);
        UUID id = UUID.randomUUID();
        try {
            tx.executeWithoutResult(status -> {
                jdbc.sql("""
                        insert into git_operations (id, workspace_id, session_id, requested_by, type, idempotency_key, params)
                        values (?, ?, ?, ?, ?, ?, cast(? as jsonb))
                        """).params(id, workspaceId, sessionId, userId, type, idempotencyKey, json.writeValueAsString(params))
                        .update();
                audit.record(workspaceId, userId, "git." + type.toLowerCase(), "git_operation", id, params);
                changed(workspaceId, userId, Map.of("operationId", id));
            });
        } catch (DuplicateKeyException e) {
            return operation(jdbc.sql("select id from git_operations where workspace_id = ? and idempotency_key = ?")
                    .params(workspaceId, idempotencyKey).query(UUID.class).single());
        }
        return operation(id);
    }

    private Operation operation(UUID id) {
        return jdbc.sql("""
                select o.*, u.display_name from git_operations o join users u on u.id = o.requested_by where o.id = ?
                """).param(id)
                .query((rs, n) -> {
                    String result = rs.getString("result");
                    Timestamp ended = rs.getTimestamp("ended_at");
                    return new Operation(rs.getObject("id", UUID.class), rs.getObject("session_id", UUID.class),
                            rs.getString("type"), rs.getString("status"), rs.getString("display_name"),
                            json.readValue(rs.getString("params"), MAP), result == null ? null : json.readValue(result, MAP),
                            rs.getString("error"), rs.getString("log"), rs.getTimestamp("created_at").toInstant(),
                            ended == null ? null : ended.toInstant());
                })
                .optional().orElseThrow(() -> ApiException.notFound("Operation"));
    }

    /** The pull request's description: the task and its plan, with owners and status. */
    private String describe(UUID sessionId, String task) {
        StringBuilder body = new StringBuilder("Opened from a Converge session.\n\n**Task:** ").append(task).append("\n");
        List<String> steps = jdbc.sql("""
                select p.position, p.title, p.status, u.display_name from plan_steps p left join users u on u.id = p.owner_id
                where p.session_id = ? order by p.position
                """).param(sessionId)
                .query((rs, n) -> "- [" + ("DONE".equals(rs.getString(3)) ? "x" : " ") + "] " + rs.getString(2)
                        + (rs.getString(4) == null ? "" : " (" + rs.getString(4) + ")"))
                .list();
        if (!steps.isEmpty()) body.append("\n**Plan:**\n").append(String.join("\n", steps)).append("\n");
        return body.toString();
    }

    private void flushWorkspace(UUID workspaceId) {
        List<UUID> files = jdbc.sql("select id from files where workspace_id = ? and kind = 'FILE' and deleted_at is null")
                .param(workspaceId).query(UUID.class).list();
        try {
            files.forEach(collab::flush);
        } catch (ApiException e) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "The workspace files could not be stored first; try again");
        }
    }

    private static void requireBranch(String branch) {
        if (branch == null || !BRANCH.matcher(branch).matches()) throw ApiException.badRequest("That is not a valid branch name");
    }

    static String slug(String text) {
        String slug = text.toLowerCase().replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        if (slug.length() > 40) slug = slug.substring(0, 40).replaceAll("-+$", "");
        return slug.isEmpty() ? "session" : slug;
    }

    private static String truncate(String text, int max) {
        return text.length() <= max ? text : text.substring(0, max);
    }

    static String credentialContext(UUID workspaceId) {
        return "git-credential:" + workspaceId;
    }

    private void changed(UUID workspaceId, UUID actorId, Map<String, Object> payload) {
        events.publishEvent(WorkspaceEvent.of("GIT_CHANGED", workspaceId, actorId, payload));
    }
}
