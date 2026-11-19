package dev.converge.api.session;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
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

import dev.converge.api.agent.AgentTurns.Turn;
import dev.converge.api.auth.AppUser;
import dev.converge.api.session.Comments.Comment;
import dev.converge.api.session.Comments.NewComment;
import dev.converge.api.session.Sessions.Card;
import dev.converge.api.session.Sessions.Detail;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

@RestController
public class SessionController {

    public record NewSession(@NotBlank @Size(max = 2000) String task) {
    }

    public record Join(@NotNull Sessions.Mode mode) {
    }

    public record Versioned(int rowVersion) {
    }

    public record Takeover(int rowVersion, @Size(max = 4000) String guidance) {
    }

    public record Handoff(@NotNull UUID toUserId, int rowVersion) {
    }

    public record NewSteps(@NotEmpty @Size(max = 50) List<@NotBlank @Size(max = 300) String> titles) {
    }

    public record StepUpdate(@NotNull Plans.Status status, Boolean release, int rowVersion) {
    }

    public record CommentBody(Comments.Target targetKind, UUID sessionId, UUID fileId, UUID turnId, UUID stepId,
            Map<String, Object> anchor, @Size(max = 2000) String quote, @NotBlank @Size(max = 4000) String body) {
    }

    private final Sessions sessions;
    private final Plans plans;
    private final Comments comments;
    private final WorkspaceAccess access;

    public SessionController(Sessions sessions, Plans plans, Comments comments, WorkspaceAccess access) {
        this.sessions = sessions;
        this.plans = plans;
        this.comments = comments;
        this.access = access;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/sessions")
    List<Card> board(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId) {
        return sessions.board(workspaceId, user.id());
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/sessions")
    ResponseEntity<Card> create(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @Valid @RequestBody NewSession body) {
        return ResponseEntity.status(HttpStatus.CREATED).body(sessions.create(workspaceId, user.id(), body.task().strip()));
    }

    @GetMapping("/api/v1/sessions/{sessionId}")
    Detail detail(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId) {
        return sessions.detail(sessionId, user.id());
    }

    @PostMapping("/api/v1/sessions/{sessionId}/join")
    Card join(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId, @Valid @RequestBody Join body) {
        return sessions.join(sessionId, user.id(), body.mode());
    }

    @PostMapping("/api/v1/sessions/{sessionId}/leave")
    Card leave(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId) {
        return sessions.leave(sessionId, user.id());
    }

    @PostMapping("/api/v1/sessions/{sessionId}/takeover")
    Turn takeover(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId, @Valid @RequestBody Takeover body) {
        return sessions.takeover(sessionId, user.id(), user.displayName(), body.rowVersion(), body.guidance());
    }

    @PostMapping("/api/v1/sessions/{sessionId}/handoff")
    Card handoff(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId, @Valid @RequestBody Handoff body) {
        return sessions.handoff(sessionId, user.id(), body.toUserId(), body.rowVersion());
    }

    @PostMapping("/api/v1/sessions/{sessionId}/finish")
    Card finish(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId, @RequestBody Versioned body) {
        return sessions.finish(sessionId, user.id(), body.rowVersion());
    }

    @PostMapping("/api/v1/sessions/{sessionId}/steps")
    List<Plans.Step> addSteps(@AuthenticationPrincipal AppUser user, @PathVariable UUID sessionId,
            @Valid @RequestBody NewSteps body) {
        access.require(sessions.workspaceOf(sessionId), user.id(), Role.EDITOR);
        return plans.add(sessionId, body.titles(), null, user.id());
    }

    @PostMapping("/api/v1/steps/{stepId}/take")
    Plans.Step take(@AuthenticationPrincipal AppUser user, @PathVariable UUID stepId, @RequestBody Versioned body) {
        return plans.take(stepId, body.rowVersion(), user.id());
    }

    @PatchMapping("/api/v1/steps/{stepId}")
    Plans.Step updateStep(@AuthenticationPrincipal AppUser user, @PathVariable UUID stepId,
            @Valid @RequestBody StepUpdate body) {
        return plans.update(stepId, body.status(), Boolean.TRUE.equals(body.release()), body.rowVersion(), user.id());
    }

    @DeleteMapping("/api/v1/steps/{stepId}")
    ResponseEntity<Void> deleteStep(@AuthenticationPrincipal AppUser user, @PathVariable UUID stepId) {
        plans.delete(stepId, user.id());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/comments")
    List<Comment> comments(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @RequestParam(required = false) UUID fileId, @RequestParam(required = false) UUID sessionId) {
        return comments.list(workspaceId, user.id(), fileId, sessionId);
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/comments")
    ResponseEntity<Comment> comment(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @Valid @RequestBody CommentBody body) {
        if (body.targetKind() == null) throw dev.converge.api.common.ApiException.badRequest("targetKind is required");
        return ResponseEntity.status(HttpStatus.CREATED).body(comments.create(workspaceId, user.id(),
                new NewComment(body.sessionId(), body.targetKind(), body.fileId(), body.turnId(), body.stepId(),
                        body.anchor(), body.quote(), body.body())));
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/comments/{commentId}/resolve")
    Comment resolve(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId, @PathVariable UUID commentId,
            @RequestBody Map<String, Boolean> body) {
        return comments.resolve(workspaceId, commentId, user.id(), !Boolean.FALSE.equals(body.get("resolved")));
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/comments/{commentId}/to-step")
    Comment toStep(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId, @PathVariable UUID commentId) {
        return comments.toStep(workspaceId, commentId, user.id());
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/comments/{commentId}/to-prompt")
    Turn toPrompt(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId, @PathVariable UUID commentId) {
        return comments.toPrompt(workspaceId, commentId, user.id(), user.displayName());
    }
}
