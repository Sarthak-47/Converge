package dev.converge.api.history;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import dev.converge.api.audit.AuditLog;
import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.CollabClient;
import dev.converge.api.realtime.WorkspaceEvent;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * Plaintext versions of files (FR-10, design §9.2). Versions are taken on request, automatically after a quiet
 * period, and always just before an external change, so a restore can itself be undone. Restoring goes
 * through the external-change path: the old text is merged in as edits, keeping concurrent typing (design §8.9).
 */
@Service
public class HistoryService {

    public enum Reason { MANUAL, AUTO, PRE_EXTERNAL }

    public record Version(UUID id, int versionNo, Reason reason, String label, UUID createdBy, String createdByName,
            Instant createdAt, String contentHash) {
    }

    public record VersionText(UUID id, int versionNo, String text) {
    }

    private static final Logger log = LoggerFactory.getLogger(HistoryService.class);

    private static final String SELECT_VERSION = """
            select s.id, s.version_no, s.reason, s.label, s.created_by, u.display_name, s.created_at, s.content_hash
            from snapshots s left join users u on u.id = s.created_by
            """;

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final CollabClient collab;
    private final AuditLog audit;
    private final ApplicationEventPublisher events;

    public HistoryService(JdbcClient jdbc, WorkspaceAccess access, CollabClient collab, AuditLog audit,
            ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.access = access;
        this.collab = collab;
        this.audit = audit;
        this.events = events;
    }

    public List<Version> list(UUID fileId, UUID userId) {
        access.require(workspaceOf(fileId), userId, Role.VIEWER);
        return jdbc.sql(SELECT_VERSION + " where s.file_id = ? order by s.version_no desc limit 200")
                .param(fileId)
                .query(this::toVersion)
                .list();
    }

    public VersionText text(UUID fileId, UUID snapshotId, UUID userId) {
        access.require(workspaceOf(fileId), userId, Role.VIEWER);
        return jdbc.sql("select id, version_no, text_content from snapshots where id = ? and file_id = ?")
                .params(snapshotId, fileId)
                .query((rs, n) -> new VersionText(rs.getObject(1, UUID.class), rs.getInt(2), rs.getString(3)))
                .optional()
                .orElseThrow(() -> ApiException.notFound("Version"));
    }

    /** A named checkpoint. Returns the latest version unchanged when nothing changed since it was taken. */
    public Version checkpoint(UUID fileId, UUID userId, String label) {
        access.require(workspaceOf(fileId), userId, Role.EDITOR);
        collab.flush(fileId);
        return take(fileId, Reason.MANUAL, label, userId).orElseGet(() -> latest(fileId).orElseThrow());
    }

    /** Takes a version just before text from outside the editor is merged in (design §9.2). */
    public void beforeExternalChange(UUID fileId, UUID userId, String label) {
        collab.flush(fileId);
        take(fileId, Reason.PRE_EXTERNAL, label, userId);
    }

    /** Restores an old version by merging its text into the live document (Gate D). */
    public Version restore(UUID fileId, UUID snapshotId, UUID userId) {
        UUID workspaceId = workspaceOf(fileId);
        access.require(workspaceId, userId, Role.EDITOR);
        VersionText target = text(fileId, snapshotId, userId);
        beforeExternalChange(fileId, userId, "Before restoring version " + target.versionNo());
        collab.applyText(fileId, target.text(), "restore:" + snapshotId);
        audit.record(workspaceId, userId, "file.restored", "file", fileId, Map.of("version", target.versionNo()));
        events.publishEvent(WorkspaceEvent.of("FILE_RESTORED", workspaceId, userId,
                Map.of("fileId", fileId, "version", target.versionNo())));
        return latest(fileId).orElseThrow();
    }

    /** Versions files that have been quiet for 30 seconds since their last change (design §9.2). */
    @Scheduled(fixedDelay = 60_000, initialDelay = 60_000)
    void autoSnapshot() {
        List<UUID> due = jdbc.sql("""
                select d.file_id
                from documents d join files f on f.id = d.file_id
                where f.deleted_at is null
                  and d.updated_at < now() - interval '30 seconds'
                  and d.updated_at > coalesce((select max(s.created_at) from snapshots s where s.file_id = d.file_id), '-infinity')
                limit 100
                """)
                .query(UUID.class)
                .list();
        for (UUID fileId : due) {
            try {
                take(fileId, Reason.AUTO, null, null);
            } catch (RuntimeException e) {
                log.warn("Automatic version of file {} failed", fileId, e);
            }
        }
    }

    /** Records the current materialized text as a new version, unless it equals the latest version. */
    Optional<Version> take(UUID fileId, Reason reason, String label, UUID userId) {
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                int inserted = jdbc.sql("""
                        insert into snapshots (id, file_id, version_no, text_content, content_hash, reason, label, created_by)
                        select ?, d.file_id,
                               coalesce((select max(version_no) from snapshots where file_id = d.file_id), 0) + 1,
                               d.text_content, d.content_hash, ?, ?, ?
                        from documents d
                        where d.file_id = ?
                          and d.content_hash is distinct from (
                              select s.content_hash from snapshots s where s.file_id = d.file_id
                              order by s.version_no desc limit 1)
                        """)
                        .params(UUID.randomUUID(), reason.name(), label, userId, fileId)
                        .update();
                return inserted == 0 ? Optional.empty() : latest(fileId);
            } catch (DuplicateKeyException e) {
                // Another version was numbered at the same moment; take the next number.
            }
        }
        throw ApiException.conflict("Could not record a version; try again");
    }

    private Optional<Version> latest(UUID fileId) {
        return jdbc.sql(SELECT_VERSION + " where s.file_id = ? order by s.version_no desc limit 1")
                .param(fileId)
                .query(this::toVersion)
                .optional();
    }

    private UUID workspaceOf(UUID fileId) {
        return jdbc.sql("select workspace_id from files where id = ? and deleted_at is null and kind = 'FILE'")
                .param(fileId)
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("File"));
    }

    private Version toVersion(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Version(rs.getObject(1, UUID.class), rs.getInt(2), Reason.valueOf(rs.getString(3)), rs.getString(4),
                rs.getObject(5, UUID.class), rs.getString(6), rs.getObject(7, OffsetDateTime.class).toInstant(),
                rs.getString(8));
    }
}
