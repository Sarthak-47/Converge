package dev.converge.api.realtime;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.socket.CloseStatus;

import dev.converge.api.workspace.MemberService.AccessChanged;
import dev.converge.api.workspace.Role;

/**
 * Makes role changes reach connections that are already open (FR-18, design §13.5). REST calls and STOMP
 * sends are re-authorized on every request anyway; this covers long-lived sockets:
 * document connections are downgraded or closed, and a removed member's workspace sockets are closed.
 */
@Component
class AccessRevoker {

    private static final Logger log = LoggerFactory.getLogger(AccessRevoker.class);
    static final CloseStatus ACCESS_REMOVED = new CloseStatus(4403, "Workspace access removed");

    private final CollabClient collab;
    private final WebSocketSessions sessions;

    AccessRevoker(CollabClient collab, WebSocketSessions sessions) {
        this.collab = collab;
        this.sessions = sessions;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    void onAccessChanged(AccessChanged change) {
        String action = change.role() == null ? "close" : change.role().atLeast(Role.EDITOR) ? "read-write" : "read-only";
        try {
            collab.revoke(change.userId(), change.workspaceId(), action);
        } catch (RuntimeException e) {
            // The database change already stands; reconnecting clients are re-authorized from it.
            log.warn("Could not update live document connections for user {} in workspace {}",
                    change.userId(), change.workspaceId(), e);
        }
        if (change.role() == null) {
            sessions.closeAll(change.userId(), ACCESS_REMOVED);
        }
    }
}
