package dev.converge.api.workspace;

import java.text.Normalizer;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import dev.converge.api.common.ApiException;

@Service
public class WorkspaceService {

    public enum Status { ACTIVE, ARCHIVED }

    public record WorkspaceView(UUID id, String name, String slug, Status status, Role role) {
    }

    private static final String SELECT_VIEW = """
            select w.id, w.name, w.slug, w.status, m.role
            from workspaces w join workspace_members m on m.workspace_id = w.id
            """;

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;

    public WorkspaceService(JdbcClient jdbc, WorkspaceAccess access) {
        this.jdbc = jdbc;
        this.access = access;
    }

    /** Creates the workspace and its owner membership atomically (design §6.3). */
    @Transactional
    public WorkspaceView create(UUID ownerId, String name) {
        UUID id = UUID.randomUUID();
        String slug = uniqueSlug(ownerId, slugify(name));
        jdbc.sql("insert into workspaces (id, owner_id, name, slug) values (?, ?, ?, ?)")
                .params(id, ownerId, name.trim(), slug)
                .update();
        jdbc.sql("insert into workspace_members (workspace_id, user_id, role) values (?, ?, 'OWNER')")
                .params(id, ownerId)
                .update();
        return new WorkspaceView(id, name.trim(), slug, Status.ACTIVE, Role.OWNER);
    }

    public List<WorkspaceView> listFor(UUID userId) {
        return jdbc.sql(SELECT_VIEW + " where m.user_id = ? order by w.created_at")
                .param(userId)
                .query(this::toView)
                .list();
    }

    public WorkspaceView get(UUID workspaceId, UUID userId) {
        access.require(workspaceId, userId, Role.VIEWER);
        return jdbc.sql(SELECT_VIEW + " where w.id = ? and m.user_id = ?")
                .params(workspaceId, userId)
                .query(this::toView)
                .single();
    }

    @Transactional
    public WorkspaceView update(UUID workspaceId, UUID userId, String name, Status status) {
        access.require(workspaceId, userId, Role.OWNER);
        if (name != null) {
            jdbc.sql("update workspaces set name = ? where id = ?").params(name.trim(), workspaceId).update();
        }
        if (status != null) {
            jdbc.sql("update workspaces set status = ? where id = ?").params(status.name(), workspaceId).update();
        }
        return get(workspaceId, userId);
    }

    private WorkspaceView toView(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new WorkspaceView(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("slug"),
                Status.valueOf(rs.getString("status")), Role.valueOf(rs.getString("role")));
    }

    static String slugify(String name) {
        String ascii = Normalizer.normalize(name, Normalizer.Form.NFKD).replaceAll("\\p{M}", "");
        String slug = ascii.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
        if (slug.isEmpty()) {
            slug = "workspace";
        }
        return slug.length() > 60 ? slug.substring(0, 60).replaceAll("-$", "") : slug;
    }

    private String uniqueSlug(UUID ownerId, String base) {
        List<String> taken = jdbc.sql("select slug from workspaces where owner_id = ? and (slug = ? or slug like ?)")
                .params(ownerId, base, base + "-%")
                .query(String.class)
                .list();
        if (!taken.contains(base)) {
            return base;
        }
        for (int i = 2; i < 10_000; i++) {
            String candidate = base + "-" + i;
            if (!taken.contains(candidate)) {
                return candidate;
            }
        }
        throw ApiException.conflict("Too many workspaces with that name");
    }
}
