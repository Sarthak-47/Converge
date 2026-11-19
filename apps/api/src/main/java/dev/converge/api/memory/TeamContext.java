package dev.converge.api.memory;

import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import dev.converge.api.common.ApiException;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * What an agent should know about the team before it starts (design §13.6, §13.10, §13.11): notes pinned to
 * the code it is likely to touch, and other sessions working on the same files. Agents fail open for context:
 * if these lookups fail, the turn proceeds with a visible "context may be stale" warning (design §13.12).
 */
@Service
public class TeamContext {

    /** Another session working on some of the same files. */
    public record Overlap(UUID sessionId, String task, String driverName, String status, List<String> files) {
    }

    public record Context(String text, boolean stale) {
    }

    private static final Logger log = LoggerFactory.getLogger(TeamContext.class);
    static final String STALE_WARNING = "Workspace memory and overlap checks were unavailable, so this context may be stale.";

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final Memories memories;
    private final RangeLocks locks;

    public TeamContext(JdbcClient jdbc, WorkspaceAccess access, Memories memories, RangeLocks locks) {
        this.jdbc = jdbc;
        this.access = access;
        this.memories = memories;
        this.locks = locks;
    }

    /** Files a session's agents have opened or changed recently. */
    List<UUID> sessionFiles(UUID sessionId) {
        return jdbc.sql("""
                select file_id from agent_turn_touches tt join agent_turns t on t.id = tt.turn_id
                where t.session_id = ? and tt.touched_at > now() - interval '24 hours'
                union
                select tf.file_id from agent_turn_files tf join agent_turns t on t.id = tf.turn_id
                where t.session_id = ? and t.started_at > now() - interval '24 hours'
                """).params(sessionId, sessionId).query(UUID.class).list();
    }

    /** Other active sessions touching the same files: same file is "overlapping" (design §13.11). */
    public List<Overlap> overlaps(UUID sessionId, UUID userId) {
        UUID workspaceId = jdbc.sql("select workspace_id from sessions where id = ?").param(sessionId).query(UUID.class)
                .optional().orElseThrow(() -> ApiException.notFound("Session"));
        access.require(workspaceId, userId, Role.VIEWER);
        return overlapsOf(workspaceId, sessionId);
    }

    List<Overlap> overlapsOf(UUID workspaceId, UUID sessionId) {
        List<UUID> mine = sessionFiles(sessionId);
        if (mine.isEmpty()) return List.of();
        record Hit(UUID sessionId, String task, String driver, String status, String path) {
        }
        List<Hit> hits = jdbc.sql("""
                select distinct s.id, s.task, u.display_name, s.status, f.path
                from sessions s join users u on u.id = s.driver_id
                join agent_turns t on t.session_id = s.id
                left join agent_turn_touches tt on tt.turn_id = t.id
                left join agent_turn_files tf on tf.turn_id = t.id
                join files f on f.id = coalesce(tt.file_id, tf.file_id) and f.deleted_at is null
                where s.workspace_id = ? and s.id <> ? and s.status <> 'DONE'
                  and t.started_at > now() - interval '24 hours'
                  and f.id = any(?)
                order by f.path
                """)
                .params(workspaceId, sessionId, mine.toArray(new UUID[0]))
                .query((rs, n) -> new Hit(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)))
                .list();
        return hits.stream().collect(Collectors.groupingBy(Hit::sessionId, java.util.LinkedHashMap::new, Collectors.toList()))
                .values().stream()
                .map(list -> new Overlap(list.getFirst().sessionId(), list.getFirst().task(), list.getFirst().driver(),
                        list.getFirst().status(), list.stream().map(Hit::path).distinct().toList()))
                .toList();
    }

    /** The context block for an agent turn's first message; never throws. */
    public Context forTurn(UUID workspaceId, UUID sessionId) {
        try {
            List<UUID> files = sessionId == null ? List.of() : sessionFiles(sessionId);
            StringBuilder text = new StringBuilder();
            List<Memories.Memory> notes = memories.relevant(workspaceId, files, 15);
            if (!notes.isEmpty()) {
                text.append("Workspace memory: notes teammates and agents pinned to code. A STALE note no longer matches")
                        .append(" its code; if you work there, rewrite it with update_memory or retire it with retire_memory.\n");
                for (Memories.Memory note : notes) {
                    String about = note.anchoredText().lines().findFirst().orElse("");
                    if (about.length() > 80) about = about.substring(0, 80) + "…";
                    text.append("- [").append(note.id()).append("] ").append(note.path()).append(" (")
                            .append(note.kind().name().toLowerCase()).append(", ").append(note.status().toLowerCase())
                            .append("): ").append(note.body()).append(" — about: \"").append(about).append("\"\n");
                }
            }
            if (sessionId != null) {
                List<Overlap> overlaps = overlapsOf(workspaceId, sessionId);
                if (!overlaps.isEmpty()) {
                    text.append("\nOther sessions are working on the same files; coordinate instead of duplicating work:\n");
                    for (Overlap o : overlaps) {
                        text.append("- \"").append(o.task()).append("\" (driven by ").append(o.driverName()).append("): ")
                                .append(String.join(", ", o.files())).append("\n");
                    }
                }
            }
            List<RangeLocks.Lock> held = locks.active(workspaceId, null);
            if (!held.isEmpty()) {
                text.append("\nRanges teammates are holding; do not edit them:\n");
                for (RangeLocks.Lock lock : held) {
                    text.append("- ").append(lock.path()).append(": held by ").append(lock.holderName()).append(" (")
                            .append(lock.reason()).append(")\n");
                }
            }
            return new Context(text.toString().strip(), false);
        } catch (RuntimeException e) {
            log.warn("Team context unavailable for workspace {}: {}", workspaceId, e.getMessage());
            return new Context(STALE_WARNING, true);
        }
    }
}
