package dev.converge.api.agent;

import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.agent.AgentTurns.TurnRow;
import dev.converge.api.common.ApiException;
import dev.converge.api.file.FileService;
import dev.converge.api.file.FileService.FileNode;
import dev.converge.api.file.FileService.Kind;
import dev.converge.api.realtime.TicketService;
import dev.converge.api.session.Plans;

/**
 * The runner's view of the workspace (design §5.3, §13.4). Every call names a turn; the API checks the turn is
 * live and its member may still edit, then acts as that member. Reached only with the internal token.
 */
@RestController
@RequestMapping("/internal/agent/turns/{turnId}")
public class AgentInternalController {

    public record Entry(UUID id, String path, String kind) {
    }

    public record Hit(String path, int line, String text) {
    }

    public record TicketRequest(@NotNull UUID fileId) {
    }

    public record CreateFile(@NotBlank @Size(max = 1000) String path) {
    }

    public record UsageReport(@PositiveOrZero long inputTokens, @PositiveOrZero long outputTokens,
            @PositiveOrZero long cacheReadTokens, @PositiveOrZero long cacheWriteTokens,
            @PositiveOrZero long costMicros, String model) {
    }

    public record RevertState(@NotBlank String state, @NotNull Map<String, Object> undo) {
    }

    public record Finish(@NotBlank String status, @Size(max = 2000) String error, @Size(max = 40) String code) {
    }

    public record ProposePlan(@jakarta.validation.constraints.NotEmpty @Size(max = 20) List<@NotBlank @Size(max = 300) String> steps) {
    }

    public record StepStatus(int position, @NotNull Plans.Status status) {
    }

    private static final java.util.Set<String> FINAL = java.util.Set.of(
            "SUCCEEDED", "FAILED", "CANCELLED", "REFUSED", "BUDGET_EXCEEDED");
    private static final java.util.Set<String> EVENT_KINDS = java.util.Set.of("text", "note", "tool");

    private final AgentTurns turns;
    private final Plans plans;
    private final dev.converge.api.common.ConvergeMetrics metrics;
    private final FileService files;
    private final TicketService tickets;
    private final JdbcClient jdbc;

    public AgentInternalController(AgentTurns turns, Plans plans, FileService files, TicketService tickets,
            JdbcClient jdbc, dev.converge.api.common.ConvergeMetrics metrics) {
        this.turns = turns;
        this.plans = plans;
        this.metrics = metrics;
        this.files = files;
        this.tickets = tickets;
        this.jdbc = jdbc;
    }

    @GetMapping("/tree")
    List<Entry> tree(@PathVariable UUID turnId) {
        TurnRow row = turns.running(turnId);
        return files.tree(row.workspaceId(), row.sponsorId()).stream()
                .map(n -> new Entry(n.id(), n.path(), n.kind().name()))
                .toList();
    }

    /** Literal search over the stored text (which trails live typing by the store debounce). */
    @GetMapping("/search")
    List<Hit> search(@PathVariable UUID turnId, @RequestParam("q") @NotBlank @Size(max = 200) String query) {
        TurnRow row = turns.running(turnId);
        record Doc(String path, String text) {
        }
        List<Doc> docs = jdbc.sql("""
                select f.path, d.text_content from files f join documents d on d.file_id = f.id
                where f.workspace_id = ? and f.deleted_at is null and f.kind = 'FILE' and strpos(d.text_content, ?) > 0
                order by f.path limit 200
                """)
                .params(row.workspaceId(), query)
                .query((rs, n) -> new Doc(rs.getString("path"), rs.getString("text_content")))
                .list();
        List<Hit> hits = new ArrayList<>();
        for (Doc doc : docs) {
            String[] lines = doc.text().split("\n", -1);
            for (int i = 0; i < lines.length && hits.size() < 100; i++) {
                if (lines[i].contains(query)) {
                    String line = lines[i].length() > 300 ? lines[i].substring(0, 300) + "…" : lines[i];
                    hits.add(new Hit(doc.path(), i + 1, line));
                }
            }
        }
        return hits;
    }

    @PostMapping("/tickets")
    TicketService.Ticket ticket(@PathVariable UUID turnId, @Valid @RequestBody TicketRequest body) {
        TurnRow row = turns.row(turnId);
        UUID user = turns.actingUser(row);
        int inWorkspace = jdbc.sql("select count(*) from files where id = ? and workspace_id = ?")
                .params(body.fileId(), row.workspaceId()).query(Integer.class).single();
        if (inWorkspace == 0) throw ApiException.notFound("File");
        if ("RUNNING".equals(row.status())) {
            // An agent opening a file counts as touching it, for overlap warnings (design §13.11).
            jdbc.sql("insert into agent_turn_touches (turn_id, file_id) values (?, ?) on conflict (turn_id, file_id) do update set touched_at = now()")
                    .params(turnId, body.fileId()).update();
        }
        return tickets.issue(body.fileId(), user);
    }

    /** Creates a file and any missing folders, as the sponsor. */
    @PostMapping("/files")
    Entry create(@PathVariable UUID turnId, @Valid @RequestBody CreateFile body) {
        TurnRow row = turns.running(turnId);
        String[] segments = body.path().strip().replace('\\', '/').replaceAll("^/+|/+$", "").split("/+");
        List<FileNode> tree = files.tree(row.workspaceId(), row.sponsorId());
        UUID parentId = null;
        String prefix = "";
        for (int i = 0; i < segments.length - 1; i++) {
            String folderPath = prefix + segments[i];
            FileNode folder = tree.stream().filter(n -> n.path().equals(folderPath)).findFirst().orElse(null);
            if (folder == null) {
                folder = files.create(row.workspaceId(), parentId, segments[i], Kind.FOLDER, row.sponsorId());
            } else if (folder.kind() != Kind.FOLDER) {
                throw ApiException.badRequest(folderPath + " is a file, not a folder");
            }
            parentId = folder.id();
            prefix = folderPath + "/";
        }
        FileNode file = files.create(row.workspaceId(), parentId, segments[segments.length - 1], Kind.FILE,
                row.sponsorId());
        return new Entry(file.id(), file.path(), file.kind().name());
    }

    @PostMapping("/events")
    ResponseEntity<Void> event(@PathVariable UUID turnId, @RequestBody Map<String, Object> body) {
        Object kind = body.get("kind");
        if (!(kind instanceof String k) || !EVENT_KINDS.contains(k)) throw ApiException.badRequest("Unknown event kind");
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("kind", kind);
        for (String key : List.of("text", "name", "summary")) {
            if (body.get(key) instanceof String value) event.put(key, value.length() > 20_000 ? value.substring(0, 20_000) : value);
        }
        if (body.get("ok") instanceof Boolean ok) event.put("ok", ok);
        if ("tool".equals(kind)) metrics.toolCall(String.valueOf(body.get("name")), Boolean.TRUE.equals(body.get("ok")));
        turns.event(turnId, event);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/usage")
    Map<String, Long> usage(@PathVariable UUID turnId, @Valid @RequestBody UsageReport body) {
        long total = turns.usage(turnId, body.inputTokens(), body.outputTokens(), body.cacheReadTokens(),
                body.cacheWriteTokens(), body.costMicros());
        metrics.modelResponse(body.model(), body.inputTokens(), body.cacheReadTokens(), body.cacheWriteTokens());
        return Map.of("costMicros", total);
    }

    @PutMapping("/files/{fileId}/revert-state")
    ResponseEntity<Void> revertState(@PathVariable UUID turnId, @PathVariable UUID fileId,
            @Valid @RequestBody RevertState body) {
        byte[] state;
        try {
            state = Base64.getDecoder().decode(body.state());
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest("state must be base64");
        }
        turns.saveRevertState(turnId, fileId, state, body.undo());
        return ResponseEntity.noContent().build();
    }

    /** The session's plan, for the agent's plan tools (design §13.4). */
    @GetMapping("/plan")
    List<Plans.Step> plan(@PathVariable UUID turnId) {
        return plans.steps(sessionOf(turns.running(turnId)));
    }

    /** Adds steps owned by the sponsor: an agent proposes, its member owns the work. */
    @PostMapping("/plan")
    List<Plans.Step> propose(@PathVariable UUID turnId, @Valid @RequestBody ProposePlan body) {
        TurnRow row = turns.running(turnId);
        return plans.add(sessionOf(row), body.steps(), row.sponsorId(), row.sponsorId());
    }

    @PostMapping("/plan/status")
    List<Plans.Step> stepStatus(@PathVariable UUID turnId, @Valid @RequestBody StepStatus body) {
        TurnRow row = turns.running(turnId);
        return plans.updateByPosition(sessionOf(row), body.position(), body.status(), row.sponsorId());
    }

    private static UUID sessionOf(TurnRow row) {
        if (row.sessionId() == null) throw ApiException.badRequest("This turn is not part of a session, so it has no plan");
        return row.sessionId();
    }

    @PostMapping("/finish")
    ResponseEntity<Void> finish(@PathVariable UUID turnId, @Valid @RequestBody Finish body) {
        if (!FINAL.contains(body.status())) throw ApiException.badRequest("Unknown status");
        turns.finish(turnId, body.status(), body.error(), body.code());
        return ResponseEntity.noContent().build();
    }
}
