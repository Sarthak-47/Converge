package dev.converge.api.realtime;

import java.io.IOException;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.WebSocketHandlerDecorator;

import dev.converge.api.auth.AppUser;

/**
 * Open workspace-channel sockets per user, so access that is taken away can be cut off at once rather than
 * when the person next reconnects (FR-18).
 */
@Component
public class WebSocketSessions {

    private static final Logger log = LoggerFactory.getLogger(WebSocketSessions.class);

    private final ConcurrentHashMap<UUID, Set<WebSocketSession>> byUser = new ConcurrentHashMap<>();

    WebSocketHandler decorate(WebSocketHandler handler) {
        return new WebSocketHandlerDecorator(handler) {
            @Override
            public void afterConnectionEstablished(WebSocketSession session) throws Exception {
                UUID user = userOf(session);
                if (user != null) {
                    byUser.computeIfAbsent(user, id -> ConcurrentHashMap.newKeySet()).add(session);
                }
                super.afterConnectionEstablished(session);
            }

            @Override
            public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
                UUID user = userOf(session);
                if (user != null) {
                    byUser.computeIfPresent(user, (id, sessions) -> {
                        sessions.remove(session);
                        return sessions.isEmpty() ? null : sessions;
                    });
                }
                super.afterConnectionClosed(session, status);
            }
        };
    }

    /** Closes every socket the user has open; their clients reconnect and are re-authorized from scratch. */
    public void closeAll(UUID userId, CloseStatus status) {
        for (WebSocketSession session : byUser.getOrDefault(userId, Set.of())) {
            try {
                session.close(status);
            } catch (IOException e) {
                log.warn("Could not close WebSocket session {} of user {}", session.getId(), userId, e);
            }
        }
    }

    private static UUID userOf(WebSocketSession session) {
        return session.getPrincipal() instanceof Authentication auth && auth.getPrincipal() instanceof AppUser user
                ? user.id() : null;
    }
}
