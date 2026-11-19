package dev.converge.api.memory;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.agent.AgentTurns;
import dev.converge.api.auth.AppUser;
import dev.converge.api.memory.Memories.Check;
import dev.converge.api.memory.Memories.Memory;
import dev.converge.api.memory.Memories.NewMemory;
import dev.converge.api.memory.RangeLocks.Lock;
import dev.converge.api.memory.TeamContext.Overlap;

@RestController
public class MemoryController {

    public record MemoryBody(@NotNull UUID fileId, @NotNull Memories.Kind kind, @NotBlank @Size(max = 2000) String body,
            @NotNull Map<String, Object> anchor, @NotBlank @Size(max = 4000) String anchoredText) {
    }

    public record MemoryUpdate(@Size(max = 2000) String body, Map<String, Object> anchor,
            @Size(max = 4000) String anchoredText, Integer rowVersion, Boolean retire) {
    }

    public record LockBody(@NotNull UUID fileId, @NotNull Map<String, Object> anchor, @NotNull @Size(max = 4000) String quote,
            @NotBlank @Size(max = 300) String reason, Integer minutes) {
    }

    public record Checks(@NotNull @Size(max = 1000) List<Check> checks) {
    }

    private final Memories memories;
    private final RangeLocks locks;
    private final TeamContext context;
    private final AgentTurns turns;

    public MemoryController(Memories memories, RangeLocks locks, TeamContext context, AgentTurns turns) {
        this.memories = memories;
        this.locks = locks;
        this.context = context;
        this.turns = turns;
    }

    // ---- People ---------------------------------------------------------------------------------------

    @GetMapping("/api/v1/workspaces/{workspaceId}/memories")
    List<Memory> list(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @RequestParam(required = false) UUID fileId, @RequestParam(defaultValue = "false") boolean includeRetired) {
        return memories.list(workspaceId, user.id(), fileId, includeRetired);
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/memories")
    ResponseEntity<Memory> create(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @Valid @RequestBody MemoryBody body) {
        return ResponseEntity.status(HttpStatus.CREATED).body(memories.create(workspaceId, user.id(), null,
                new NewMemory(body.fileId(), body.kind(), body.body(), body.anchor(), body.anchoredText())));
    }

    @PatchMapping("/api/v1/memories/{memoryId}")
    Memory update(@AuthenticationPrincipal AppUser user, @PathVariable UUID memoryId, @Valid @RequestBody MemoryUpdate body) {
        if (Boolean.TRUE.equals(body.retire())) return memories.retire(memoryId, user.id());
        return memories.update(memoryId, user.id(), body.body(), body.anchor(), body.anchoredText(), body.rowVersion());
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/locks")
    List<Lock> locks(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @RequestParam(required = false) UUID fileId) {
        return locks.list(workspaceId, user.id(), fileId);
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/locks")
    ResponseEntity<Lock> hold(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @Valid @RequestBody LockBody body) {
        return ResponseEntity.status(HttpStatus.CREATED).body(locks.hold(workspaceId, user.id(), body.fileId(),
                body.anchor(), body.quote(), body.reason(), body.minutes()));
    }

    @DeleteMapping("/api/v1/locks/{lockId}")
    ResponseEntity<Void> release(@AuthenticationPrincipal AppUser user, @PathVariable UUID lockId) {
        locks.release(lockId, user.id());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/api/v1/sessions/{sessionId}/overlaps")
    List<Overlap> overlaps(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId) {
        return context.overlaps(sessionId, user.id());
    }

    // ---- The collaboration service, after storing a document ------------------------------------------

    @PostMapping("/internal/memories/checked")
    ResponseEntity<Void> checked(@Valid @RequestBody Checks body) {
        memories.checked(body.checks());
        return ResponseEntity.noContent().build();
    }

    // ---- The runner, acting as the turn's sponsor -----------------------------------------------------

    @GetMapping("/internal/agent/turns/{turnId}/memory")
    List<Memory> memoryForTurn(@PathVariable UUID turnId, @RequestParam(required = false) UUID fileId) {
        AgentTurns.TurnRef turn = turns.runningRef(turnId);
        return memories.list(turn.workspaceId(), turn.sponsorId(), fileId, false);
    }

    @PostMapping("/internal/agent/turns/{turnId}/memory")
    Memory writeMemory(@PathVariable UUID turnId, @Valid @RequestBody MemoryBody body) {
        AgentTurns.TurnRef turn = turns.runningRef(turnId);
        return memories.create(turn.workspaceId(), turn.sponsorId(), turnId,
                new NewMemory(body.fileId(), body.kind(), body.body(), body.anchor(), body.anchoredText()));
    }

    @PostMapping("/internal/agent/turns/{turnId}/memory/{memoryId}")
    Memory updateMemory(@PathVariable UUID turnId, @PathVariable UUID memoryId, @Valid @RequestBody MemoryUpdate body) {
        AgentTurns.TurnRef turn = turns.runningRef(turnId);
        if (!turn.workspaceId().equals(memories.workspaceOf(memoryId))) throw dev.converge.api.common.ApiException.notFound("Note");
        if (Boolean.TRUE.equals(body.retire())) return memories.retire(memoryId, turn.sponsorId());
        return memories.update(memoryId, turn.sponsorId(), body.body(), body.anchor(), body.anchoredText(), body.rowVersion());
    }

    @GetMapping("/internal/agent/turns/{turnId}/files/{fileId}/locks")
    List<Lock> locksForTurn(@PathVariable UUID turnId, @PathVariable UUID fileId) {
        AgentTurns.TurnRef turn = turns.runningRef(turnId);
        return locks.active(turn.workspaceId(), fileId);
    }
}
