package dev.converge.api.audit;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import tools.jackson.databind.json.JsonMapper;

import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * Append-only record of security-sensitive workspace actions (FR-15): membership and role changes,
 * workspace settings, deletions. Written in the same transaction as the change it describes.
 */
@Component
public class AuditLog {

    public record AuditEvent(UUID id, UUID actorId, String actorName, String action, String entityType,
            String entityId, String metadata, Instant createdAt) {
    }

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final JsonMapper json = JsonMapper.builder().build();

    public AuditLog(JdbcClient jdbc, WorkspaceAccess access) {
        this.jdbc = jdbc;
        this.access = access;
    }

    public void record(UUID workspaceId, UUID actorId, String action, String entityType, Object entityId,
            Map<String, ?> metadata) {
        jdbc.sql("""
                insert into audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, metadata)
                values (?, ?, ?, ?, ?, ?, cast(? as jsonb))
                """)
                .params(UUID.randomUUID(), workspaceId, actorId, action, entityType,
                        entityId == null ? null : entityId.toString(), json.writeValueAsString(metadata))
                .update();
    }

    /** The newest events first; owners only, since the log names who did what. */
    public List<AuditEvent> recent(UUID workspaceId, UUID userId) {
        access.require(workspaceId, userId, Role.OWNER);
        return jdbc.sql("""
                select a.id, a.actor_id, u.display_name, a.action, a.entity_type, a.entity_id, a.metadata::text,
                       a.created_at
                from audit_events a join users u on u.id = a.actor_id
                where a.workspace_id = ?
                order by a.created_at desc, a.id desc
                limit 100
                """)
                .param(workspaceId)
                .query((rs, n) -> new AuditEvent(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6), rs.getString(7),
                        rs.getObject(8, OffsetDateTime.class).toInstant()))
                .list();
    }
}
