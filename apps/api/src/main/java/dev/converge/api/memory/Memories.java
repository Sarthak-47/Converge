package dev.converge.api.memory;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.WorkspaceEvent;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Workspace memory (design §13.10): short notes pinned to code with Yjs relative positions and the text they
 * were written about. The collaboration service re-checks each note whenever its document is stored and
 * flags it STALE when that code is deleted or rewritten; the next agent working nearby is asked to rewrite or
 * retire it. People and agents can read, edit or retire any note.
 */
@Service
public class Memories {

    public enum Kind { DECISION, GOTCHA, CONVENTION, NOTE }

    public record Memory(UUID id, UUID fileId, String path, Kind kind, String body, Map<String, Object> anchor,
            String anchoredText, String currentText, Float similarity, String status, UUID createdBy,
            String authorName, UUID createdInTurn, int rowVersion, Instant updatedAt) {
    }

    public record NewMemory(UUID fileId, Kind kind, String body, Map<String, Object> anchor, String anchoredText) {
    }

    /** What the collaboration service found when it re-checked a note against the stored document. */
    public record Check(UUID id, String currentText, Float similarity, String status) {
    }

    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };
    private static final String SELECT = """
            select m.*, f.path, u.display_name from memories m join files f on f.id = m.file_id
            join users u on u.id = m.created_by
            """;

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;
    private final JsonMapper json = JsonMapper.builder().build();

    public Memories(JdbcClient jdbc, WorkspaceAccess access, ApplicationEventPublisher events, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.access = access;
        this.events = events;
        this.tx = tx;
    }

    public Memory create(UUID workspaceId, UUID userId, UUID turnId, NewMemory input) {
        access.require(workspaceId, userId, Role.COMMENTER);
        validate(input.body(), input.anchor(), input.anchoredText());
        if (input.kind() == null) throw ApiException.badRequest("kind is required");
        int inWorkspace = jdbc.sql("select count(*) from files where id = ? and workspace_id = ? and kind = 'FILE' and deleted_at is null")
                .params(input.fileId(), workspaceId).query(Integer.class).single();
        if (inWorkspace == 0) throw ApiException.notFound("File");
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> {
            jdbc.sql("""
                    insert into memories (id, workspace_id, file_id, kind, body, anchor, anchored_text, anchor_hash,
                        current_text, similarity, created_by, created_in_turn)
                    values (?, ?, ?, ?, ?, cast(? as jsonb), ?, ?, ?, 1, ?, ?)
                    """)
                    .params(id, workspaceId, input.fileId(), input.kind().name(), input.body().strip(),
                            json.writeValueAsString(input.anchor()), input.anchoredText(), hash(input.anchoredText()),
                            input.anchoredText(), userId, turnId)
                    .update();
            changed(workspaceId, userId, List.of(id));
        });
        return find(id);
    }

    public List<Memory> list(UUID workspaceId, UUID userId, UUID fileId, boolean includeRetired) {
        access.require(workspaceId, userId, Role.VIEWER);
        return jdbc.sql(SELECT + """
                where m.workspace_id = ? and (cast(? as uuid) is null or m.file_id = ?)
                  and (? or m.status <> 'RETIRED') and f.deleted_at is null
                order by f.path, m.created_at limit 300
                """)
                .params(workspaceId, fileId, fileId, includeRetired)
                .query((rs, n) -> map(rs)).list();
    }

    /**
     * Rewrites a note: a new body, and optionally a new anchor and anchored text, which makes it current again.
     * Compare-and-set on row_version, so two people editing one note cannot silently overwrite each other.
     */
    public Memory update(UUID memoryId, UUID userId, String body, Map<String, Object> anchor, String anchoredText,
            Integer rowVersion) {
        Memory current = find(memoryId);
        UUID workspaceId = workspaceOf(memoryId);
        access.require(workspaceId, userId, Role.COMMENTER);
        if ("RETIRED".equals(current.status())) throw ApiException.conflict("This note was retired");
        String newBody = body == null || body.isBlank() ? current.body() : body.strip();
        boolean reanchor = anchor != null;
        validate(newBody, reanchor ? anchor : current.anchor(), reanchor ? anchoredText : current.anchoredText());
        int expected = rowVersion == null ? current.rowVersion() : rowVersion;
        tx.executeWithoutResult(status -> {
            int updated = jdbc.sql("""
                    update memories set body = ?, anchor = cast(? as jsonb), anchored_text = ?, anchor_hash = ?,
                        current_text = case when ? then ? else current_text end,
                        similarity = case when ? then 1 else similarity end,
                        status = case when ? then 'ACTIVE' else status end,
                        updated_by = ?, updated_at = now(), row_version = row_version + 1
                    where id = ? and row_version = ? and status <> 'RETIRED'
                    """)
                    .params(newBody, json.writeValueAsString(reanchor ? anchor : current.anchor()),
                            reanchor ? anchoredText : current.anchoredText(),
                            hash(reanchor ? anchoredText : current.anchoredText()),
                            reanchor, anchoredText, reanchor, reanchor, userId, memoryId, expected)
                    .update();
            if (updated == 0) throw ApiException.conflict("The note changed meanwhile; reload it");
            changed(workspaceId, userId, List.of(memoryId));
        });
        return find(memoryId);
    }

    public Memory retire(UUID memoryId, UUID userId) {
        UUID workspaceId = workspaceOf(memoryId);
        access.require(workspaceId, userId, Role.COMMENTER);
        tx.executeWithoutResult(status -> {
            jdbc.sql("update memories set status = 'RETIRED', updated_by = ?, updated_at = now(), row_version = row_version + 1 where id = ?")
                    .params(userId, memoryId).update();
            changed(workspaceId, userId, List.of(memoryId));
        });
        return find(memoryId);
    }

    /** Applies the collaboration service's re-check; publishes only notes whose status changed. */
    public void checked(List<Check> checks) {
        record Changed(UUID id, UUID workspaceId) {
        }
        List<Changed> changed = new java.util.ArrayList<>();
        for (Check check : checks) {
            if (!Set.of("ACTIVE", "STALE").contains(check.status())) throw ApiException.badRequest("Unknown status");
            jdbc.sql("""
                    update memories set current_text = ?, similarity = ?, status = ?, checked_at = now(),
                        row_version = row_version + case when status = ? then 0 else 1 end
                    where id = ? and status <> 'RETIRED' and status <> ?
                    returning id, workspace_id
                    """)
                    .params(check.currentText(), check.similarity(), check.status(), check.status(), check.id(),
                            check.status())
                    .query((rs, n) -> new Changed(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)))
                    .optional().ifPresent(changed::add);
            // Text and similarity are kept current even when the status does not change.
            jdbc.sql("update memories set current_text = ?, similarity = ?, checked_at = now() where id = ? and status <> 'RETIRED'")
                    .params(check.currentText(), check.similarity(), check.id()).update();
        }
        changed.stream().collect(java.util.stream.Collectors.groupingBy(Changed::workspaceId))
                .forEach((workspaceId, list) -> events.publishEvent(WorkspaceEvent.of("MEMORY_CHANGED", workspaceId, null,
                        Map.of("memoryIds", list.stream().map(Changed::id).toList()))));
    }

    /** Notes for an agent's context: on the given files first, then the most recently changed ones. */
    public List<Memory> relevant(UUID workspaceId, List<UUID> fileIds, int limit) {
        return jdbc.sql(SELECT + """
                where m.workspace_id = ? and m.status <> 'RETIRED' and f.deleted_at is null
                order by (m.file_id = any(?)) desc, (m.status = 'STALE') desc, m.updated_at desc limit ?
                """)
                .params(workspaceId, fileIds.toArray(new UUID[0]), limit)
                .query((rs, n) -> map(rs)).list();
    }

    Memory find(UUID id) {
        return jdbc.sql(SELECT + " where m.id = ?").param(id).query((rs, n) -> map(rs)).optional()
                .orElseThrow(() -> ApiException.notFound("Note"));
    }

    UUID workspaceOf(UUID memoryId) {
        return jdbc.sql("select workspace_id from memories where id = ?").param(memoryId).query(UUID.class)
                .optional().orElseThrow(() -> ApiException.notFound("Note"));
    }

    private void validate(String body, Map<String, Object> anchor, String anchoredText) {
        if (body == null || body.isBlank() || body.length() > 2000) throw ApiException.badRequest("A note needs 1 to 2000 characters");
        if (anchor == null || !anchor.containsKey("start") || !anchor.containsKey("end")) throw ApiException.badRequest("A note needs an anchor");
        if (json.writeValueAsString(anchor).length() > 4000) throw ApiException.badRequest("Anchor too large");
        if (anchoredText == null || anchoredText.isEmpty() || anchoredText.length() > 4000) {
            throw ApiException.badRequest("A note must point at 1 to 4000 characters of code");
        }
    }

    private void changed(UUID workspaceId, UUID actorId, List<UUID> ids) {
        events.publishEvent(WorkspaceEvent.of("MEMORY_CHANGED", workspaceId, actorId, Map.of("memoryIds", ids)));
    }

    private Memory map(ResultSet rs) throws SQLException {
        float similarity = rs.getFloat("similarity");
        return new Memory(rs.getObject("id", UUID.class), rs.getObject("file_id", UUID.class), rs.getString("path"),
                Kind.valueOf(rs.getString("kind")), rs.getString("body"), json.readValue(rs.getString("anchor"), MAP),
                rs.getString("anchored_text"), rs.getString("current_text"), rs.wasNull() ? null : similarity,
                rs.getString("status"), rs.getObject("created_by", UUID.class), rs.getString("display_name"),
                rs.getObject("created_in_turn", UUID.class), rs.getInt("row_version"),
                rs.getTimestamp("updated_at").toInstant());
    }

    static String hash(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
