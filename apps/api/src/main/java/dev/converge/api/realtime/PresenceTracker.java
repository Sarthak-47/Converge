package dev.converge.api.realtime;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.context.annotation.Lazy;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.socket.messaging.SessionUnsubscribeEvent;

import dev.converge.api.auth.AppUser;

/**
 * Who has a workspace open right now (FR-08). A person is online while at least one of their tabs is
 * subscribed to the workspace's presence topic; joins are recorded only after the subscription has been
 * authorized, so a rejected subscriber never appears.
 *
 * Ephemeral by design (design §2.2): held in memory, never persisted, and rebuilt as clients reconnect.
 */
@Component
public class PresenceTracker {

    public record OnlineUser(UUID userId, String displayName, int connections) {
    }

    private record Viewer(UUID userId, String displayName) {
    }

    /** workspace -> (stomp session id + subscription id) -> viewer */
    private final Map<UUID, Map<String, Viewer>> byWorkspace = new ConcurrentHashMap<>();
    private final SimpMessagingTemplate messaging;

    public PresenceTracker(@Lazy SimpMessagingTemplate messaging) {
        this.messaging = messaging;
    }

    public static String topic(UUID workspaceId) {
        return "/topic/workspace/" + workspaceId + "/presence";
    }

    void join(UUID workspaceId, String sessionId, String subscriptionId, AppUser user) {
        byWorkspace.computeIfAbsent(workspaceId, id -> new ConcurrentHashMap<>())
                .put(key(sessionId, subscriptionId), new Viewer(user.id(), user.displayName()));
        broadcast(workspaceId);
    }

    public List<OnlineUser> online(UUID workspaceId) {
        Map<UUID, OnlineUser> people = new LinkedHashMap<>();
        byWorkspace.getOrDefault(workspaceId, Map.of()).values().forEach(v -> people.merge(v.userId(),
                new OnlineUser(v.userId(), v.displayName(), 1),
                (a, b) -> new OnlineUser(a.userId(), a.displayName(), a.connections() + 1)));
        return people.values().stream().sorted(Comparator.comparing(OnlineUser::displayName)).toList();
    }

    @EventListener
    void onUnsubscribe(SessionUnsubscribeEvent event) {
        StompHeaderAccessor stomp = StompHeaderAccessor.wrap(event.getMessage());
        removeWhere(k -> k.equals(key(stomp.getSessionId(), stomp.getSubscriptionId())));
    }

    @EventListener
    void onDisconnect(SessionDisconnectEvent event) {
        String prefix = event.getSessionId() + "/";
        removeWhere(k -> k.startsWith(prefix));
    }

    private void removeWhere(java.util.function.Predicate<String> match) {
        Set<UUID> changed = new java.util.HashSet<>();
        byWorkspace.forEach((workspaceId, viewers) -> {
            if (viewers.keySet().removeIf(match)) {
                changed.add(workspaceId);
            }
        });
        changed.forEach(this::broadcast);
    }

    private void broadcast(UUID workspaceId) {
        messaging.convertAndSend(topic(workspaceId), online(workspaceId));
    }

    private static String key(String sessionId, String subscriptionId) {
        return sessionId + "/" + subscriptionId;
    }
}
