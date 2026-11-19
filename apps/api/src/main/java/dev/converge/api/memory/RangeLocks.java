package dev.converge.api.memory;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
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
 * Advisory range locks (design §13.11): a person holds an exact range for a while and connected agents are
 * told to stay out of it. People are never blocked; the CRDT already prevents lost edits, and the problem
 * being solved is wasted or conflicting work. Locks expire on their own.
 */
@Service
public class RangeLocks {

    public record Lock(UUID id, UUID fileId, String path, Map<String, Object> anchor, String quote, String reason,
            UUID holderId, String holderName, Instant expiresAt) {
    }

    static final Duration DEFAULT_HOLD = Duration.ofHours(2);
    static final Duration MAX_HOLD = Duration.ofHours(24);
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;
    private final JsonMapper json = JsonMapper.builder().build();

    public RangeLocks(JdbcClient jdbc, WorkspaceAccess access, ApplicationEventPublisher events, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.access = access;
        this.events = events;
        this.tx = tx;
    }

    public Lock hold(UUID workspaceId, UUID userId, UUID fileId, Map<String, Object> anchor, String quote, String reason,
            Integer minutes) {
        access.require(workspaceId, userId, Role.EDITOR);
        if (anchor == null || !anchor.containsKey("start") || !anchor.containsKey("end")) throw ApiException.badRequest("A lock needs an anchor");
        if (reason == null || reason.isBlank() || reason.length() > 300) throw ApiException.badRequest("Say briefly why you hold this range");
        if (quote == null || quote.length() > 4000) throw ApiException.badRequest("A lock covers at most 4000 characters");
        int inWorkspace = jdbc.sql("select count(*) from files where id = ? and workspace_id = ? and deleted_at is null")
                .params(fileId, workspaceId).query(Integer.class).single();
        if (inWorkspace == 0) throw ApiException.notFound("File");
        Duration hold = minutes == null ? DEFAULT_HOLD : Duration.ofMinutes(Math.max(1, minutes));
        if (hold.compareTo(MAX_HOLD) > 0) hold = MAX_HOLD;
        UUID id = UUID.randomUUID();
        Instant expires = Instant.now().plus(hold);
        tx.executeWithoutResult(status -> {
            jdbc.sql("""
                    insert into range_locks (id, workspace_id, file_id, anchor, quote, reason, holder_id, expires_at)
                    values (?, ?, ?, cast(? as jsonb), ?, ?, ?, ?)
                    """)
                    .params(id, workspaceId, fileId, json.writeValueAsString(anchor), quote, reason.strip(), userId,
                            Timestamp.from(expires))
                    .update();
            changed(workspaceId, userId);
        });
        return active(workspaceId, null).stream().filter(l -> l.id().equals(id)).findFirst().orElseThrow();
    }

    public List<Lock> list(UUID workspaceId, UUID userId, UUID fileId) {
        access.require(workspaceId, userId, Role.VIEWER);
        return active(workspaceId, fileId);
    }

    /** The holder releases their lock; an owner can release anyone's. */
    public void release(UUID lockId, UUID userId) {
        record Row(UUID workspaceId, UUID holderId) {
        }
        Row row = jdbc.sql("select workspace_id, holder_id from range_locks where id = ? and released_at is null")
                .param(lockId).query((rs, n) -> new Row(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)))
                .optional().orElseThrow(() -> ApiException.notFound("Lock"));
        Role role = access.require(row.workspaceId(), userId, Role.EDITOR);
        if (!row.holderId().equals(userId) && role != Role.OWNER) throw ApiException.forbidden("Only the holder or an owner can release this lock");
        tx.executeWithoutResult(status -> {
            jdbc.sql("update range_locks set released_at = now() where id = ?").param(lockId).update();
            changed(row.workspaceId(), userId);
        });
    }

    List<Lock> active(UUID workspaceId, UUID fileId) {
        return jdbc.sql("""
                select l.*, f.path, u.display_name from range_locks l join files f on f.id = l.file_id
                join users u on u.id = l.holder_id
                where l.workspace_id = ? and (cast(? as uuid) is null or l.file_id = ?)
                  and l.released_at is null and l.expires_at > now() and f.deleted_at is null
                order by l.created_at
                """)
                .params(workspaceId, fileId, fileId)
                .query((rs, n) -> new Lock(rs.getObject("id", UUID.class), rs.getObject("file_id", UUID.class),
                        rs.getString("path"), json.readValue(rs.getString("anchor"), MAP), rs.getString("quote"),
                        rs.getString("reason"), rs.getObject("holder_id", UUID.class), rs.getString("display_name"),
                        rs.getTimestamp("expires_at").toInstant()))
                .list();
    }

    private void changed(UUID workspaceId, UUID actorId) {
        events.publishEvent(WorkspaceEvent.of("LOCKS_CHANGED", workspaceId, actorId, Map.of()));
    }
}
