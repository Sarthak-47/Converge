package dev.converge.api.git;

import java.net.URI;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.HexFormat;
import java.util.UUID;
import java.util.regex.Matcher;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
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

    private static final SecureRandom RANDOM = new SecureRandom();

    public record Repository(String remoteUrl, String defaultBranch, String owner, String repo, String credentialHint,
            String connectedByName, Instant updatedAt, boolean webhook) {
    }

    /** Shown once when automatic import is turned on: where GitHub should send pushes, and how to sign them. */
    public record Webhook(String path, String secret) {
    }

    /** What a webhook delivery did. */
    public enum Delivery { PING, IGNORED, QUEUED }

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
    private final dev.converge.api.common.RateLimiter limits;
    private final dev.converge.api.file.FileService fileService;
    private final JsonMapper json = JsonMapper.builder().build();

    public GitService(JdbcClient jdbc, WorkspaceAccess access, SecretBox box, CollabClient collab, AuditLog audit,
            ApplicationEventPublisher events, TransactionTemplate tx, dev.converge.api.common.RateLimiter limits,
            dev.converge.api.file.FileService fileService,
            @Value("${converge.git.allow-insecure-remotes:false}") boolean allowInsecureRemotes) {
        this.limits = limits;
        this.fileService = fileService;
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
                        connected_by = excluded.connected_by, updated_at = now(),
                        -- What Converge knows about the branch holds only while it is the same branch.
                        known_paths = case when git_repositories.remote_url = excluded.remote_url
                            and git_repositories.default_branch = excluded.default_branch
                            then git_repositories.known_paths else '{}' end
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
                        rs.getString("display_name"), rs.getTimestamp("updated_at").toInstant(),
                        rs.getBytes("webhook_secret") != null))
                .optional();
    }

    // ---- Webhooks (design §10.2): a push to the default branch imports it automatically --------------------

    /** Turns automatic import on, with a fresh secret; any earlier secret stops working. Owners only. */
    public Webhook enableWebhook(UUID workspaceId, UUID userId) {
        access.require(workspaceId, userId, Role.OWNER);
        byte[] raw = new byte[32];
        RANDOM.nextBytes(raw);
        String secret = HexFormat.of().formatHex(raw);
        int updated = jdbc.sql("update git_repositories set webhook_secret = ?, webhook_enabled_at = now() where workspace_id = ?")
                .params(box.seal(secret, webhookContext(workspaceId)), workspaceId).update();
        if (updated == 0) throw ApiException.conflict("Connect a GitHub repository to this workspace first");
        audit.record(workspaceId, userId, "git.webhook_enabled", "workspace", workspaceId, Map.of());
        changed(workspaceId, userId, Map.of());
        return new Webhook("/api/v1/git/webhooks/" + workspaceId, secret);
    }

    public void disableWebhook(UUID workspaceId, UUID userId) {
        access.require(workspaceId, userId, Role.OWNER);
        jdbc.sql("update git_repositories set webhook_secret = null, webhook_enabled_at = null where workspace_id = ?")
                .param(workspaceId).update();
        audit.record(workspaceId, userId, "git.webhook_disabled", "workspace", workspaceId, Map.of());
        changed(workspaceId, userId, Map.of());
    }

    /**
     * A delivery from GitHub. Nothing is trusted before the signature checks out: an unknown workspace, a
     * workspace without a secret and a wrong signature all look the same from outside (404). A push to the
     * default branch queues an import as the person who connected the repository, keyed by GitHub's delivery id,
     * so a redelivered event never imports twice.
     */
    public Delivery webhook(UUID workspaceId, String event, String deliveryId, String signature, byte[] body) {
        record Hook(byte[] secret, String branch, UUID connectedBy) {
        }
        Hook hook = jdbc.sql("""
                select webhook_secret, default_branch, connected_by from git_repositories
                where workspace_id = ? and webhook_secret is not null
                """).param(workspaceId)
                .query((rs, n) -> new Hook(rs.getBytes(1), rs.getString(2), rs.getObject(3, UUID.class)))
                .optional().orElseThrow(() -> ApiException.notFound("Webhook"));
        String secret = box.open(hook.secret(), webhookContext(workspaceId));
        if (!validSignature(secret, signature, body)) throw ApiException.notFound("Webhook");
        if ("ping".equals(event)) return Delivery.PING;
        if (!"push".equals(event)) return Delivery.IGNORED;
        String ref;
        try {
            ref = json.readTree(body).path("ref").asString("");
        } catch (RuntimeException e) {
            throw ApiException.badRequest("The push event is not valid JSON");
        }
        if (!("refs/heads/" + hook.branch()).equals(ref)) return Delivery.IGNORED;
        if (deliveryId == null || deliveryId.isBlank() || deliveryId.length() > 80) {
            throw ApiException.badRequest("A delivery id (X-GitHub-Delivery) is required");
        }
        pull(workspaceId, hook.connectedBy(), "webhook:" + deliveryId);
        return Delivery.QUEUED;
    }

    static boolean validSignature(String secret, String header, byte[] body) {
        if (header == null || !header.startsWith("sha256=")) return false;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] expected = mac.doFinal(body);
            byte[] presented = HexFormat.of().parseHex(header.substring("sha256=".length()));
            return MessageDigest.isEqual(expected, presented);
        } catch (IllegalArgumentException | java.security.GeneralSecurityException e) {
            return false;
        }
    }

    static String webhookContext(UUID workspaceId) {
        return "git-webhook:" + workspaceId;
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

    /**
     * Imports the repository's default branch into the workspace (design §10.2, "pull"): new files are created,
     * changed files are merged into the live documents as external edits, so typing in progress survives.
     */
    public Operation pull(UUID workspaceId, UUID userId, String idempotencyKey) {
        access.require(workspaceId, userId, Role.EDITOR);
        String branch = jdbc.sql("select default_branch from git_repositories where workspace_id = ?").param(workspaceId)
                .query(String.class).optional()
                .orElseThrow(() -> ApiException.conflict("Connect a GitHub repository to this workspace first"));
        return enqueue(workspaceId, null, userId, "PULL", idempotencyKey,
                Map.of("branch", branch, "message", "Import " + branch));
    }

    public record ImportedFile(String path, String text) {
    }

    public record ImportResult(int created, int updated, int unchanged, List<String> refused) {
    }

    /** One batch of files from the worker, applied as the person who asked for the import. */
    public ImportResult importFiles(UUID operationId, List<ImportedFile> files) {
        record Op(UUID workspaceId, UUID userId, String type, String status) {
        }
        Op op = jdbc.sql("select workspace_id, requested_by, type, status from git_operations where id = ?").param(operationId)
                .query((rs, n) -> new Op(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), rs.getString(4)))
                .optional().orElseThrow(() -> ApiException.notFound("Operation"));
        if (!"PULL".equals(op.type()) || !"RUNNING".equals(op.status())) throw ApiException.conflict("This operation is not a running import");
        access.require(op.workspaceId(), op.userId(), Role.EDITOR);
        Map<String, UUID> existing = new java.util.HashMap<>();
        jdbc.sql("select path, id from files where workspace_id = ? and kind = 'FILE' and deleted_at is null")
                .param(op.workspaceId())
                .query((rs, n) -> existing.put(rs.getString(1), rs.getObject(2, UUID.class))).list();
        int created = 0;
        int updated = 0;
        int unchanged = 0;
        List<String> refused = new java.util.ArrayList<>();
        for (ImportedFile file : files) {
            try {
                UUID fileId = existing.get(file.path());
                if (fileId == null) {
                    fileId = fileService.createPath(op.workspaceId(), file.path(), op.userId()).id();
                    existing.put(file.path(), fileId);
                    if (!file.text().isEmpty()) fileService.save(fileId, file.text(), null, op.userId());
                    created++;
                } else {
                    String current = jdbc.sql("select text_content from documents where file_id = ?").param(fileId)
                            .query(String.class).single();
                    if (current.equals(file.text())) {
                        unchanged++;
                    } else {
                        fileService.save(fileId, file.text(), null, op.userId());
                        updated++;
                    }
                }
            } catch (ApiException e) {
                refused.add(file.path() + ": " + e.getMessage());
            }
        }
        return new ImportResult(created, updated, unchanged, refused);
    }

    /** Pushes the workspace's current text as a branch, without a pull request. */
    public Operation pushBranch(UUID workspaceId, UUID userId, String idempotencyKey, String branch, String message) {
        access.require(workspaceId, userId, Role.EDITOR);
        requireBranch(branch);
        if (message == null || message.isBlank()) throw ApiException.badRequest("A commit needs a message");
        // The worker force-pushes the branch it rebuilds, so it never writes the default branch itself:
        // a commit that landed there in the meantime would be lost. Changes reach it through a pull request.
        boolean toDefault = jdbc.sql("select default_branch = ? from git_repositories where workspace_id = ?")
                .params(branch, workspaceId).query(Boolean.class).optional().orElse(false);
        if (toDefault) throw ApiException.badRequest("Push to a new branch and open a pull request into " + branch);
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
        limits.check(dev.converge.api.common.RateLimiter.GIT, workspaceId.toString());
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
