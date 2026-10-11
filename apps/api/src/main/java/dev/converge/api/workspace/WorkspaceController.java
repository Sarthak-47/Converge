package dev.converge.api.workspace;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.workspace.WorkspaceService.Status;
import dev.converge.api.workspace.WorkspaceService.WorkspaceView;

@RestController
@RequestMapping("/api/v1/workspaces")
public class WorkspaceController {

    public record CreateWorkspace(@NotBlank @Size(max = 100) String name) {
    }

    public record UpdateWorkspace(@Size(min = 1, max = 100) String name, Status status) {
    }

    private final WorkspaceService workspaces;

    public WorkspaceController(WorkspaceService workspaces) {
        this.workspaces = workspaces;
    }

    @GetMapping
    List<WorkspaceView> list(@AuthenticationPrincipal AppUser user) {
        return workspaces.listFor(user.id());
    }

    @PostMapping
    ResponseEntity<WorkspaceView> create(@AuthenticationPrincipal AppUser user, @Valid @RequestBody CreateWorkspace body) {
        return ResponseEntity.status(HttpStatus.CREATED).body(workspaces.create(user.id(), body.name()));
    }

    @GetMapping("/{id}")
    WorkspaceView get(@AuthenticationPrincipal AppUser user, @PathVariable UUID id) {
        return workspaces.get(id, user.id());
    }

    @PatchMapping("/{id}")
    WorkspaceView update(@AuthenticationPrincipal AppUser user, @PathVariable UUID id,
            @Valid @RequestBody UpdateWorkspace body) {
        return workspaces.update(id, user.id(), body.name(), body.status());
    }
}
