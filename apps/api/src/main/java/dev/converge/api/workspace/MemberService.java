package dev.converge.api.workspace;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import dev.converge.api.audit.AuditLog;
import dev.converge.api.auth.AppUser;
import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.WorkspaceEvent;

/**
 * Who belongs to a workspace and with which role (FR-03). Changes take effect on the server immediately;
 * {@link AccessChanged} lets open realtime connections catch up (design §13.5, FR-18).
 */
@Service
public class MemberService {

    public record Member(UUID userId, String email, String displayName, Role role, Instant joinedAt) {
    }

    public record Invitation(UUID id, String email, Role role, Instant createdAt) {
    }

    public record Roster(List<Member> members, List<Invitation> invitations) {
    }

    /** Result of adding someone: they were either added at once or invited until they sign up. */
    public record AddResult(Member member, Invitation invitation) {
    }

    /** Published after commit when someone's access to a workspace changed; role is null when removed. */
    public record AccessChanged(UUID workspaceId, UUID userId, Role role) {
    }

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final AuditLog audit;
    private final ApplicationEventPublisher events;

    public MemberService(JdbcClient jdbc, WorkspaceAccess access, AuditLog audit, ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.access = access;
        this.audit = audit;
        this.events = events;
    }

    public Roster roster(UUID workspaceId, UUID userId) {
        Role caller = access.require(workspaceId, userId, Role.VIEWER);
        List<Member> members = jdbc.sql("""
                select u.id, u.email, u.display_name, m.role, m.joined_at
                from workspace_members m join users u on u.id = m.user_id
                where m.workspace_id = ?
                order by m.joined_at, u.display_name
                """)
                .param(workspaceId)
                .query((rs, n) -> new Member(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        Role.valueOf(rs.getString(4)), rs.getObject(5, OffsetDateTime.class).toInstant()))
                .list();
        // Pending invitations reveal email addresses, so only owners see them.
        List<Invitation> invitations = caller == Role.OWNER ? invitations(workspaceId) : List.of();
        return new Roster(members, invitations);
    }

    @Transactional
    public AddResult add(UUID workspaceId, AppUser actor, String rawEmail, Role role) {
        access.require(workspaceId, actor.id(), Role.OWNER);
        String email = rawEmail.trim();
        Optional<UUID> existing = jdbc.sql("select id from users where lower(email) = lower(?)").param(email)
                .query(UUID.class).optional();
        if (existing.isPresent()) {
            UUID userId = existing.get();
            try {
                jdbc.sql("insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?)")
                        .params(workspaceId, userId, role.name()).update();
            } catch (DuplicateKeyException e) {
                throw ApiException.conflict("That person is already a member");
            }
            audit.record(workspaceId, actor.id(), "member.added", "user", userId, Map.of("role", role.name()));
            changed(workspaceId, userId, role, actor.id(), "MEMBER_ADDED");
            return new AddResult(member(workspaceId, userId), null);
        }
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("insert into workspace_invitations (id, workspace_id, email, role, invited_by) values (?, ?, ?, ?, ?)")
                    .params(id, workspaceId, email, role.name(), actor.id()).update();
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("That email has already been invited");
        }
        audit.record(workspaceId, actor.id(), "member.invited", "invitation", id, Map.of("email", email, "role", role.name()));
        return new AddResult(null, invitations(workspaceId).stream().filter(i -> i.id().equals(id)).findFirst().orElseThrow());
    }

    @Transactional
    public Member changeRole(UUID workspaceId, AppUser actor, UUID userId, Role role) {
        access.require(workspaceId, actor.id(), Role.OWNER);
        Role current = roleOf(workspaceId, userId);
        if (current == Role.OWNER && role != Role.OWNER) {
            requireAnotherOwner(workspaceId);
        }
        jdbc.sql("update workspace_members set role = ? where workspace_id = ? and user_id = ?")
                .params(role.name(), workspaceId, userId).update();
        audit.record(workspaceId, actor.id(), "member.role_changed", "user", userId,
                Map.of("from", current.name(), "to", role.name()));
        changed(workspaceId, userId, role, actor.id(), "MEMBER_ROLE_CHANGED");
        return member(workspaceId, userId);
    }

    /** Owners can remove anyone; everyone can leave. The last owner can do neither. */
    @Transactional
    public void remove(UUID workspaceId, AppUser actor, UUID userId) {
        boolean leaving = actor.id().equals(userId);
        access.require(workspaceId, actor.id(), leaving ? Role.VIEWER : Role.OWNER);
        if (roleOf(workspaceId, userId) == Role.OWNER) {
            requireAnotherOwner(workspaceId);
        }
        jdbc.sql("delete from workspace_members where workspace_id = ? and user_id = ?").params(workspaceId, userId).update();
        audit.record(workspaceId, actor.id(), leaving ? "member.left" : "member.removed", "user", userId, Map.of());
        changed(workspaceId, userId, null, actor.id(), "MEMBER_REMOVED");
    }

    @Transactional
    public void cancelInvitation(UUID workspaceId, AppUser actor, UUID invitationId) {
        access.require(workspaceId, actor.id(), Role.OWNER);
        int deleted = jdbc.sql("delete from workspace_invitations where id = ? and workspace_id = ?")
                .params(invitationId, workspaceId).update();
        if (deleted == 0) {
            throw ApiException.notFound("Invitation");
        }
        audit.record(workspaceId, actor.id(), "member.invitation_cancelled", "invitation", invitationId, Map.of());
    }

    /** Turns any invitations for this person's email into memberships; called on sign-up and sign-in. */
    @Transactional
    public void acceptInvitations(AppUser user) {
        record Pending(UUID id, UUID workspaceId, Role role, UUID invitedBy) {
        }
        List<Pending> pending = jdbc.sql("delete from workspace_invitations where lower(email) = lower(?) returning id, workspace_id, role, invited_by")
                .param(user.email())
                .query((rs, n) -> new Pending(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        Role.valueOf(rs.getString(3)), rs.getObject(4, UUID.class)))
                .list();
        for (Pending p : pending) {
            int added = jdbc.sql("""
                    insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?)
                    on conflict (workspace_id, user_id) do nothing
                    """)
                    .params(p.workspaceId(), user.id(), p.role().name()).update();
            if (added == 1) {
                audit.record(p.workspaceId(), user.id(), "member.joined", "user", user.id(),
                        Map.of("role", p.role().name(), "invitation", p.id().toString()));
                changed(p.workspaceId(), user.id(), p.role(), user.id(), "MEMBER_ADDED");
            }
        }
    }

    private void changed(UUID workspaceId, UUID userId, Role role, UUID actorId, String eventType) {
        events.publishEvent(new AccessChanged(workspaceId, userId, role));
        events.publishEvent(WorkspaceEvent.of(eventType, workspaceId, actorId,
                role == null ? Map.of("userId", userId) : Map.of("userId", userId, "role", role)));
    }

    private Role roleOf(UUID workspaceId, UUID userId) {
        return jdbc.sql("select role from workspace_members where workspace_id = ? and user_id = ?")
                .params(workspaceId, userId)
                .query((rs, n) -> Role.valueOf(rs.getString(1)))
                .optional()
                .orElseThrow(() -> ApiException.notFound("Member"));
    }

    private void requireAnotherOwner(UUID workspaceId) {
        int owners = jdbc.sql("select count(*) from workspace_members where workspace_id = ? and role = 'OWNER'")
                .param(workspaceId).query(Integer.class).single();
        if (owners <= 1) {
            throw ApiException.conflict("A workspace needs at least one owner");
        }
    }

    private Member member(UUID workspaceId, UUID userId) {
        return jdbc.sql("""
                select u.id, u.email, u.display_name, m.role, m.joined_at
                from workspace_members m join users u on u.id = m.user_id
                where m.workspace_id = ? and m.user_id = ?
                """)
                .params(workspaceId, userId)
                .query((rs, n) -> new Member(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        Role.valueOf(rs.getString(4)), rs.getObject(5, OffsetDateTime.class).toInstant()))
                .single();
    }

    private List<Invitation> invitations(UUID workspaceId) {
        return jdbc.sql("select id, email, role, created_at from workspace_invitations where workspace_id = ? order by created_at")
                .param(workspaceId)
                .query((rs, n) -> new Invitation(rs.getObject(1, UUID.class), rs.getString(2),
                        Role.valueOf(rs.getString(3)), rs.getObject(4, OffsetDateTime.class).toInstant()))
                .list();
    }
}
