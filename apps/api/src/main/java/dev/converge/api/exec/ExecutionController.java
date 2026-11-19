package dev.converge.api.exec;

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
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.common.ApiException;
import dev.converge.api.exec.Execution.Approval;
import dev.converge.api.exec.Execution.Job;
import dev.converge.api.exec.Execution.JobDetail;

@RestController
public class ExecutionController {

    public record Decision(@NotNull Boolean approve, int rowVersion) {
    }

    public record RunCommand(@NotBlank @Size(max = 500) String command) {
    }

    public record Outcome(@NotBlank String outcome) {
    }

    private final Execution execution;

    public ExecutionController(Execution execution) {
        this.execution = execution;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/approvals")
    List<Approval> approvals(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @RequestParam(required = false) UUID sessionId) {
        return execution.list(workspaceId, user.id(), sessionId);
    }

    @PostMapping("/api/v1/approvals/{approvalId}/decide")
    Approval decide(@AuthenticationPrincipal AppUser user, @PathVariable UUID approvalId, @Valid @RequestBody Decision body) {
        return execution.decide(approvalId, user.id(), body.approve(), body.rowVersion());
    }

    /** Runs an allowlisted command in the sandbox for the member themselves (design §11.4). */
    @PostMapping("/api/v1/workspaces/{workspaceId}/jobs")
    ResponseEntity<Approval> run(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @Valid @RequestBody RunCommand body) {
        return ResponseEntity.status(HttpStatus.CREATED).body(execution.runDirect(workspaceId, user.id(), body.command()));
    }

    @GetMapping("/api/v1/jobs/{jobId}")
    JobDetail job(@AuthenticationPrincipal AppUser user, @PathVariable UUID jobId) {
        return execution.detail(jobId, user.id());
    }

    @PostMapping("/api/v1/jobs/{jobId}/outcome")
    Job outcome(@AuthenticationPrincipal AppUser user, @PathVariable UUID jobId, @Valid @RequestBody Outcome body) {
        return execution.recordOutcome(jobId, user.id(), body.outcome());
    }

    // ---- Internal: the runner, for the turn that asked ------------------------------------------------

    public record ActionRequest(@NotBlank @Size(max = 500) String command) {
    }

    @PostMapping("/internal/agent/turns/{turnId}/actions")
    Approval requestAction(@PathVariable UUID turnId, @Valid @RequestBody ActionRequest body) {
        return execution.requestForTurn(turnId, body.command());
    }

    @GetMapping("/internal/agent/turns/{turnId}/approvals/{approvalId}")
    Approval approvalForTurn(@PathVariable UUID turnId, @PathVariable UUID approvalId) {
        return execution.approvalForTurn(turnId, approvalId);
    }

    @GetMapping("/internal/agent/turns/{turnId}/jobs/{jobId}")
    JobDetail jobForTurn(@PathVariable UUID turnId, @PathVariable UUID jobId) {
        return execution.jobForTurn(turnId, jobId);
    }

    // ---- Internal: the executor reports progress; it claims jobs and checks approvals itself -----------

    public record OutputReport(@NotNull @Size(max = 500) List<Map<String, String>> chunks) {
    }

    public record StatusReport(@NotBlank String status, Integer exitCode, @Size(max = 2000) String error) {
    }

    private static final java.util.Set<String> FINAL = java.util.Set.of("SUCCEEDED", "FAILED", "CANCELED", "OUTCOME_UNKNOWN");

    @PostMapping("/internal/jobs/{jobId}/output")
    ResponseEntity<Void> output(@PathVariable UUID jobId, @Valid @RequestBody OutputReport body) {
        execution.appendOutput(jobId, body.chunks());
        return ResponseEntity.noContent().build();
    }

    /** The executor changed a job's state itself (claimed, refused, interrupted): tell the workspace. */
    @PostMapping("/internal/jobs/{jobId}/notify")
    ResponseEntity<Void> notify(@PathVariable UUID jobId) {
        execution.started(jobId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/internal/jobs/{jobId}/status")
    ResponseEntity<Void> status(@PathVariable UUID jobId, @Valid @RequestBody StatusReport body) {
        if ("RUNNING".equals(body.status())) {
            execution.started(jobId);
        } else if (FINAL.contains(body.status())) {
            execution.finishJob(jobId, body.status(), body.exitCode(), body.error());
        } else {
            throw ApiException.badRequest("Unknown status");
        }
        return ResponseEntity.noContent().build();
    }
}
