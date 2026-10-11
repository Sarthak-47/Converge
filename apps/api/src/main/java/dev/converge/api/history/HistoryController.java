package dev.converge.api.history;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.history.HistoryService.Version;
import dev.converge.api.history.HistoryService.VersionText;

@RestController
@RequestMapping("/api/v1/files/{fileId}")
public class HistoryController {

    public record Checkpoint(@Size(max = 120) String label) {
    }

    public record Restore(@NotNull UUID snapshotId) {
    }

    private final HistoryService history;

    public HistoryController(HistoryService history) {
        this.history = history;
    }

    @GetMapping("/history")
    List<Version> list(@AuthenticationPrincipal AppUser user, @PathVariable UUID fileId) {
        return history.list(fileId, user.id());
    }

    @PostMapping("/snapshots")
    ResponseEntity<Version> checkpoint(@AuthenticationPrincipal AppUser user, @PathVariable UUID fileId,
            @Valid @RequestBody(required = false) Checkpoint body) {
        String label = body == null || body.label() == null || body.label().isBlank() ? null : body.label().strip();
        return ResponseEntity.status(HttpStatus.CREATED).body(history.checkpoint(fileId, user.id(), label));
    }

    @GetMapping("/snapshots/{snapshotId}")
    VersionText text(@AuthenticationPrincipal AppUser user, @PathVariable UUID fileId, @PathVariable UUID snapshotId) {
        return history.text(fileId, snapshotId, user.id());
    }

    @PostMapping("/restore")
    Version restore(@AuthenticationPrincipal AppUser user, @PathVariable UUID fileId, @Valid @RequestBody Restore body) {
        return history.restore(fileId, body.snapshotId(), user.id());
    }
}
