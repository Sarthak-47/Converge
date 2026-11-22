package dev.converge.api.agent;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.agent.AgentTurns.Turn;
import dev.converge.api.auth.AppUser;

@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/agent/turns")
public class AgentController {

    public record Prompt(@NotBlank @Size(max = 20_000) String prompt, UUID sessionId, @Size(max = 120) String model) {
    }

    public record Steer(@NotBlank @Size(max = 4000) String text) {
    }

    private final AgentTurns turns;

    public AgentController(AgentTurns turns) {
        this.turns = turns;
    }

    @GetMapping
    List<Turn> list(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @RequestParam(required = false) UUID sessionId) {
        return turns.list(workspaceId, sessionId, user.id());
    }

    @PostMapping
    ResponseEntity<Turn> start(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @Valid @RequestBody Prompt body) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(turns.start(workspaceId, body.sessionId(), user.id(), user.displayName(), body.prompt().strip(), body.model()));
    }

    /** The models a member may choose for a turn, the default first. */
    @GetMapping("/models")
    List<String> models(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId) {
        return turns.models();
    }

    public record ModelOptions(List<String> models, boolean customModels) {
    }

    /** The listed models, and whether members may also name any model on OpenAI, Gemini or OpenRouter. */
    @GetMapping("/model-options")
    ModelOptions modelOptions(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId) {
        return new ModelOptions(turns.models(), turns.customModels());
    }

    @PostMapping("/{turnId}/cancel")
    Turn cancel(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId, @PathVariable UUID turnId) {
        return turns.cancel(workspaceId, turnId, user.id());
    }

    @PostMapping("/{turnId}/steer")
    Turn steer(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId, @PathVariable UUID turnId,
            @Valid @RequestBody Steer body) {
        return turns.steer(workspaceId, turnId, user.id(), body.text().strip());
    }

    @PostMapping("/{turnId}/revert")
    Turn revert(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId, @PathVariable UUID turnId) {
        return turns.revert(workspaceId, turnId, user.id(), user.displayName());
    }
}
