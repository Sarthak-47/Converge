package dev.converge.api.realtime;

import java.security.Principal;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionConnectedEvent;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import dev.converge.api.auth.AppUser;

/**
 * Logs every workspace-channel connection and disconnection with its connection id (design §3.2,
 * observability), so a socket's whole life can be followed in the logs alongside the collaboration service's
 * own connection ids.
 */
@Component
class ConnectionLog {

    private static final Logger log = LoggerFactory.getLogger(ConnectionLog.class);

    @EventListener
    void onConnected(SessionConnectedEvent event) {
        StompHeaderAccessor stomp = StompHeaderAccessor.wrap(event.getMessage());
        log.info("Workspace channel connected: connection={} user={}", stomp.getSessionId(), userOf(event.getUser()));
    }

    @EventListener
    void onDisconnected(SessionDisconnectEvent event) {
        log.info("Workspace channel closed: connection={} user={} status={}", event.getSessionId(), userOf(event.getUser()),
                event.getCloseStatus() == null ? "unknown" : event.getCloseStatus().getCode());
    }

    private static Object userOf(Principal principal) {
        if (principal instanceof org.springframework.security.core.Authentication auth
                && auth.getPrincipal() instanceof AppUser user) {
            return user.id();
        }
        return principal == null ? "anonymous" : principal.getName();
    }
}
