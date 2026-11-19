package dev.converge.api.session;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.WorkspaceEvent;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * One plan per session (design §13.9). Every step has an owner and a status everyone sees, and progress comes
 * from here. Work belongs to people: commenters can hold, finish or hand back steps too. Changes are
 * compare-and-set on the step's row_version, so two people cannot both take the same step.
 */
@Service
public class Plans {

    public enum Status { TODO, IN_PROGRESS, DONE }

    public record Step(UUID id, int position, String title, UUID ownerId, String ownerName, Status status,
            int rowVersion) {
    }

    static final int MAX_STEPS = 50;

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final ApplicationEventPublisher events;

    public Plans(JdbcClient jdbc, WorkspaceAccess access, ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.access = access;
        this.events = events;
    }

    public List<Step> steps(UUID sessionId) {
        return jdbc.sql("""
                select s.*, u.display_name from plan_steps s left join users u on u.id = s.owner_id
                where s.session_id = ? order by s.position
                """)
                .param(sessionId)
                .query((rs, n) -> new Step(rs.getObject("id", UUID.class), rs.getInt("position"), rs.getString("title"),
                        rs.getObject("owner_id", UUID.class), rs.getString("display_name"),
                        Status.valueOf(rs.getString("status")), rs.getInt("row_version")))
                .list();
    }

    /** Adds steps at the end of the plan, owned by {@code ownerId} (null leaves them free to take). */
    @Transactional
    public List<Step> add(UUID sessionId, List<String> titles, UUID ownerId, UUID actorId) {
        SessionRef session = session(sessionId);
        int count = jdbc.sql("select count(*) from plan_steps where session_id = ?").param(sessionId).query(Integer.class).single();
        if (count + titles.size() > MAX_STEPS) throw ApiException.badRequest("A plan holds at most " + MAX_STEPS + " steps");
        int position = jdbc.sql("select coalesce(max(position), 0) from plan_steps where session_id = ?")
                .param(sessionId).query(Integer.class).single();
        for (String raw : titles) {
            String title = raw == null ? "" : raw.strip();
            if (title.isEmpty() || title.length() > 300) throw ApiException.badRequest("Each step needs a title of at most 300 characters");
            jdbc.sql("insert into plan_steps (id, session_id, position, title, owner_id) values (?, ?, ?, ?, ?)")
                    .params(UUID.randomUUID(), sessionId, ++position, title, ownerId)
                    .update();
        }
        changed(session, actorId);
        return steps(sessionId);
    }

    /** Takes an unowned, unstarted step at once; a started or owned step must be handed over by its owner. */
    @Transactional
    public Step take(UUID stepId, int rowVersion, UUID userId) {
        StepRef step = step(stepId);
        access.require(step.workspaceId(), userId, Role.COMMENTER);
        int updated = jdbc.sql("""
                update plan_steps set owner_id = ?, row_version = row_version + 1, updated_at = now()
                where id = ? and row_version = ? and owner_id is null and status = 'TODO'
                """).params(userId, stepId, rowVersion).update();
        if (updated == 0) {
            throw ApiException.conflict("This step is owned or already started; ask its owner to hand it over");
        }
        changed(session(step.sessionId()), userId);
        return find(stepId);
    }

    /** The owner moves their step along, or hands it back. */
    @Transactional
    public Step update(UUID stepId, Status status, boolean release, int rowVersion, UUID userId) {
        StepRef step = step(stepId);
        access.require(step.workspaceId(), userId, Role.COMMENTER);
        if (!userId.equals(step.ownerId())) throw ApiException.forbidden("Only the step's owner can change it");
        Status next = release && status != Status.DONE ? Status.TODO : status;
        int updated = jdbc.sql("""
                update plan_steps set status = ?, owner_id = ?, row_version = row_version + 1, updated_at = now()
                where id = ? and row_version = ?
                """).params(next.name(), release ? null : userId, stepId, rowVersion).update();
        if (updated == 0) throw ApiException.conflict("The step changed meanwhile; reload and try again");
        changed(session(step.sessionId()), userId);
        return find(stepId);
    }

    /** Used by agents: the sponsor's agent may move only the sponsor's own steps. */
    @Transactional
    public List<Step> updateByPosition(UUID sessionId, int position, Status status, UUID sponsorId) {
        Step step = steps(sessionId).stream().filter(s -> s.position() == position).findFirst()
                .orElseThrow(() -> ApiException.notFound("Step " + position));
        if (!sponsorId.equals(step.ownerId())) {
            throw ApiException.forbidden("Step " + position + " belongs to " + (step.ownerName() == null ? "nobody" : step.ownerName())
                    + "; agents only update their sponsor's steps");
        }
        update(step.id(), status, false, step.rowVersion(), sponsorId);
        return steps(sessionId);
    }

    @Transactional
    public void delete(UUID stepId, UUID userId) {
        StepRef step = step(stepId);
        access.require(step.workspaceId(), userId, Role.EDITOR);
        if (step.ownerId() != null && !step.ownerId().equals(userId)) {
            throw ApiException.forbidden("Only the step's owner can remove it");
        }
        jdbc.sql("delete from plan_steps where id = ?").param(stepId).update();
        changed(session(step.sessionId()), userId);
    }

    /** Hands every unfinished step one person owns in a session to another (design §13.8, handoff). */
    int transfer(UUID sessionId, UUID from, UUID to) {
        return jdbc.sql("""
                update plan_steps set owner_id = ?, row_version = row_version + 1, updated_at = now()
                where session_id = ? and owner_id = ? and status <> 'DONE'
                """).params(to, sessionId, from).update();
    }

    record SessionRef(UUID id, UUID workspaceId) {
    }

    record StepRef(UUID id, UUID sessionId, UUID workspaceId, UUID ownerId) {
    }

    private Step find(UUID stepId) {
        return steps(step(stepId).sessionId()).stream().filter(s -> s.id().equals(stepId)).findFirst()
                .orElseThrow(() -> ApiException.notFound("Step"));
    }

    private SessionRef session(UUID sessionId) {
        return jdbc.sql("select id, workspace_id from sessions where id = ?").param(sessionId)
                .query((rs, n) -> new SessionRef(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)))
                .optional().orElseThrow(() -> ApiException.notFound("Session"));
    }

    private StepRef step(UUID stepId) {
        return jdbc.sql("""
                select p.id, p.session_id, s.workspace_id, p.owner_id
                from plan_steps p join sessions s on s.id = p.session_id where p.id = ?
                """).param(stepId)
                .query((rs, n) -> new StepRef(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getObject(3, UUID.class), rs.getObject(4, UUID.class)))
                .optional().orElseThrow(() -> ApiException.notFound("Step"));
    }

    private void changed(SessionRef session, UUID actorId) {
        events.publishEvent(WorkspaceEvent.of("SESSION_CHANGED", session.workspaceId(), actorId,
                Map.of("sessionId", session.id())));
    }
}
