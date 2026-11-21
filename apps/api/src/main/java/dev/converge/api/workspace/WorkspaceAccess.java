package dev.converge.api.workspace;

import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import dev.converge.api.common.ApiException;

/**
 * The single place where workspace authorization is decided. Every workspace-scoped operation calls
 * {@link #require} before touching data (design §14.1).
 */
@Component
public class WorkspaceAccess {

    private final JdbcClient jdbc;

    public WorkspaceAccess(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Returns the caller's role, or fails. Non-members get 404 rather than 403 so that the existence of a
     * workspace is not revealed to people outside it. An archived workspace is read-only: anything that needs
     * more than the viewer role is refused with 409 until an owner unarchives it (FR-02).
     */
    public Role require(UUID workspaceId, UUID userId, Role minimum) {
        Membership m = membership(workspaceId, userId, minimum);
        if (m.archived() && minimum.atLeast(Role.COMMENTER)) {
            throw new ApiException(HttpStatus.CONFLICT, "This workspace is archived; an owner can unarchive it");
        }
        return m.role();
    }

    /** Like {@link #require}, for the few actions that stay open in an archived workspace: settings and membership. */
    public Role requireIgnoringArchive(UUID workspaceId, UUID userId, Role minimum) {
        return membership(workspaceId, userId, minimum).role();
    }

    private record Membership(Role role, boolean archived) {
    }

    /** One query for both the caller's role and whether the workspace is archived. */
    private Membership membership(UUID workspaceId, UUID userId, Role minimum) {
        Membership m = jdbc.sql("""
                select m.role, w.status = 'ARCHIVED' as archived
                from workspace_members m join workspaces w on w.id = m.workspace_id
                where m.workspace_id = ? and m.user_id = ?
                """)
                .params(workspaceId, userId)
                .query((rs, n) -> new Membership(Role.valueOf(rs.getString("role")), rs.getBoolean("archived")))
                .optional()
                .orElseThrow(() -> ApiException.notFound("Workspace"));
        if (!m.role().atLeast(minimum)) {
            throw ApiException.forbidden("This action needs the " + minimum.name().toLowerCase() + " role");
        }
        return m;
    }

    public boolean archived(UUID workspaceId) {
        return jdbc.sql("select status = 'ARCHIVED' from workspaces where id = ?").param(workspaceId)
                .query(Boolean.class).optional().orElse(false);
    }
}
