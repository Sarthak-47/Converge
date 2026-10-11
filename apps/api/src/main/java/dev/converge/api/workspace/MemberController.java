package dev.converge.api.workspace;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.audit.AuditLog;
import dev.converge.api.audit.AuditLog.AuditEvent;
import dev.converge.api.auth.AppUser;
import dev.converge.api.workspace.MemberService.AddResult;
import dev.converge.api.workspace.MemberService.Member;
import dev.converge.api.workspace.MemberService.Roster;

@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}")
public class MemberController {

    public record AddMember(@NotBlank @Email String email, @NotNull Role role) {
    }

    public record ChangeRole(@NotNull Role role) {
    }

    private final MemberService members;
    private final AuditLog audit;

    public MemberController(MemberService members, AuditLog audit) {
        this.members = members;
        this.audit = audit;
    }

    @GetMapping("/members")
    Roster roster(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId) {
        return members.roster(workspaceId, user.id());
    }

    @PostMapping("/members")
    ResponseEntity<AddResult> add(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @Valid @RequestBody AddMember body) {
        AddResult result = members.add(workspaceId, user, body.email(), body.role());
        return ResponseEntity.status(result.member() != null ? HttpStatus.CREATED : HttpStatus.ACCEPTED).body(result);
    }

    @PatchMapping("/members/{userId}")
    Member changeRole(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId, @PathVariable UUID userId,
            @Valid @RequestBody ChangeRole body) {
        return members.changeRole(workspaceId, user, userId, body.role());
    }

    @DeleteMapping("/members/{userId}")
    ResponseEntity<Void> remove(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @PathVariable UUID userId) {
        members.remove(workspaceId, user, userId);
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/invitations/{invitationId}")
    ResponseEntity<Void> cancelInvitation(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @PathVariable UUID invitationId) {
        members.cancelInvitation(workspaceId, user, invitationId);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/audit")
    List<AuditEvent> audit(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId) {
        return audit.recent(workspaceId, user.id());
    }
}
