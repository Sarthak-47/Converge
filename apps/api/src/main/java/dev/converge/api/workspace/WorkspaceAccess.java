package dev.converge.api.workspace;

import java.util.UUID;

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
     * workspace is not revealed to people outside it.
     */
    public Role require(UUID workspaceId, UUID userId, Role minimum) {
        Role role = jdbc.sql("select role from workspace_members where workspace_id = ? and user_id = ?")
                .params(workspaceId, userId)
                .query((rs, n) -> Role.valueOf(rs.getString("role")))
                .optional()
                .orElseThrow(() -> ApiException.notFound("Workspace"));
        if (!role.atLeast(minimum)) {
            throw ApiException.forbidden("This action needs the " + minimum.name().toLowerCase() + " role");
        }
        return role;
    }
}
