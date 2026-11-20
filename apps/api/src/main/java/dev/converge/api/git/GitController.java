package dev.converge.api.git;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.git.GitService.Operation;
import dev.converge.api.git.GitService.Repository;

@RestController
public class GitController {

    public record Connect(@NotBlank @Size(max = 500) String remoteUrl, @Size(max = 100) String defaultBranch,
            @NotBlank @Size(max = 500) String token) {
    }

    public record PullRequest(@NotBlank @Size(max = 100) String idempotencyKey, @Size(max = 200) String title,
            @Size(max = 20_000) String body) {
    }

    public record Push(@NotBlank @Size(max = 100) String idempotencyKey, @NotBlank @Size(max = 100) String branch,
            @NotBlank @Size(max = 2000) String message) {
    }

    private final GitService git;

    public GitController(GitService git) {
        this.git = git;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/git")
    ResponseEntity<Repository> repository(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId) {
        return git.repository(workspaceId, user.id()).map(ResponseEntity::ok).orElse(ResponseEntity.noContent().build());
    }

    @PutMapping("/api/v1/workspaces/{workspaceId}/git")
    Repository connect(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId, @Valid @RequestBody Connect body) {
        return git.connect(workspaceId, user.id(), body.remoteUrl(), body.defaultBranch(), body.token());
    }

    @DeleteMapping("/api/v1/workspaces/{workspaceId}/git")
    ResponseEntity<Void> disconnect(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId) {
        git.disconnect(workspaceId, user.id());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/git/operations")
    List<Operation> operations(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @RequestParam(required = false) UUID sessionId) {
        return git.operations(workspaceId, user.id(), sessionId);
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/git/pushes")
    ResponseEntity<Operation> push(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @Valid @RequestBody Push body) {
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(git.pushBranch(workspaceId, user.id(), body.idempotencyKey(), body.branch(), body.message()));
    }

    @PostMapping("/api/v1/sessions/{sessionId}/pull-request")
    ResponseEntity<Operation> pullRequest(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId,
            @Valid @RequestBody PullRequest body) {
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(git.pullRequest(sessionId, user.id(), body.idempotencyKey(), body.title(), body.body()));
    }

    /** The worker changed an operation's state itself; tell the workspace. */
    @PostMapping("/internal/git/operations/{operationId}/notify")
    ResponseEntity<Void> notify(@PathVariable UUID operationId, @RequestBody(required = false) Map<String, Object> ignored) {
        git.notifyChanged(operationId);
        return ResponseEntity.noContent().build();
    }
}
