package dev.converge.api.realtime;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import jakarta.annotation.PreDestroy;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.socket.messaging.SessionUnsubscribeEvent;

import dev.converge.api.auth.AppUser;

/**
 * Who has a workspace open right now (FR-08). A person is online while at least one of their tabs is
 * subscribed to the workspace's presence topic; joins are recorded only after the subscription has been
 * authorized, so a rejected subscriber never appears.
 *
 * Ephemeral by design (design §2.2): never persisted. With several API instances, each one writes its own
 * viewers into a Redis hash per workspace, tagged with the instance, and every instance reads the whole hash.
 * An instance proves it is alive by refreshing a short-lived key; the viewers of an instance that stopped
 * without saying goodbye drop out once that key expires. Each instance also keeps its own viewers in memory,
 * which is what it shows when Redis cannot be reached.
 */
@Component
public class PresenceTracker {

    public record OnlineUser(UUID userId, String displayName, int connections) {
    }

    private record Viewer(UUID userId, String displayName) {
    }

    private static final Logger log = LoggerFactory.getLogger(PresenceTracker.class);
    private static final Duration ALIVE_FOR = Duration.ofSeconds(30);

    /** workspace -> (stomp session id + subscription id) -> viewer, for this instance's sockets only. */
    private final Map<UUID, Map<String, Viewer>> byWorkspace = new ConcurrentHashMap<>();
    private final ClusterBus bus;
    private final StringRedisTemplate redis;

    public PresenceTracker(ClusterBus bus, StringRedisTemplate redis) {
        this.bus = bus;
        this.redis = redis;
    }

    public static String topic(UUID workspaceId) {
        return "/topic/workspace/" + workspaceId + "/presence";
    }

    void join(UUID workspaceId, String sessionId, String subscriptionId, AppUser user) {
        String key = key(sessionId, subscriptionId);
        Viewer viewer = new Viewer(user.id(), user.displayName());
        byWorkspace.computeIfAbsent(workspaceId, id -> new ConcurrentHashMap<>()).put(key, viewer);
        shared(() -> {
            heartbeat();
            redis.opsForHash().put(workspaceKey(workspaceId), bus.instanceId() + "/" + key, encode(viewer));
        });
        broadcast(workspaceId);
    }

    public List<OnlineUser> online(UUID workspaceId) {
        List<Viewer> viewers = sharedViewers(workspaceId);
        if (viewers == null) viewers = List.copyOf(byWorkspace.getOrDefault(workspaceId, Map.of()).values());
        Map<UUID, OnlineUser> people = new LinkedHashMap<>();
        viewers.forEach(v -> people.merge(v.userId(),
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

    /** Keeps this instance's viewers counted; scheduled well inside the key's lifetime. */
    @Scheduled(fixedDelay = 10_000)
    void heartbeat() {
        shared(() -> redis.opsForValue().set(instanceKey(bus.instanceId()), "1", ALIVE_FOR));
    }

    /** A clean shutdown takes this instance's viewers out at once instead of after the key expires. */
    @PreDestroy
    void leave() {
        shared(() -> redis.delete(instanceKey(bus.instanceId())));
    }

    private void removeWhere(java.util.function.Predicate<String> match) {
        Map<UUID, List<String>> removed = new HashMap<>();
        byWorkspace.forEach((workspaceId, viewers) -> viewers.keySet().removeIf(key -> {
            if (!match.test(key)) return false;
            removed.computeIfAbsent(workspaceId, id -> new ArrayList<>()).add(bus.instanceId() + "/" + key);
            return true;
        }));
        removed.forEach((workspaceId, fields) -> {
            shared(() -> redis.opsForHash().delete(workspaceKey(workspaceId), fields.toArray()));
            broadcast(workspaceId);
        });
    }

    /** Everyone's viewers of a workspace, from every live instance; null when Redis cannot be read. */
    private List<Viewer> sharedViewers(UUID workspaceId) {
        if (!bus.enabled()) return null;
        try {
            Map<Object, Object> entries = redis.opsForHash().entries(workspaceKey(workspaceId));
            Set<String> instances = new HashSet<>();
            entries.keySet().forEach(field -> instances.add(instanceOf(field.toString())));
            List<String> ids = new ArrayList<>(instances);
            List<String> alive = ids.isEmpty() ? List.of() : redis.opsForValue().multiGet(ids.stream().map(PresenceTracker::instanceKey).toList());
            Set<String> live = new HashSet<>();
            for (int i = 0; i < ids.size(); i++) {
                if (alive != null && alive.get(i) != null) live.add(ids.get(i));
            }
            live.add(bus.instanceId());
            List<Viewer> viewers = new ArrayList<>();
            List<Object> stale = new ArrayList<>();
            entries.forEach((field, value) -> {
                if (live.contains(instanceOf(field.toString()))) viewers.add(decode(value.toString()));
                else stale.add(field);
            });
            if (!stale.isEmpty()) redis.opsForHash().delete(workspaceKey(workspaceId), stale.toArray());
            return viewers;
        } catch (RuntimeException e) {
            log.warn("Presence shown for this instance only: Redis unavailable ({})", e.getMessage());
            return null;
        }
    }

    private void broadcast(UUID workspaceId) {
        bus.send(topic(workspaceId), online(workspaceId));
    }

    private void shared(Runnable write) {
        if (!bus.enabled()) return;
        try {
            write.run();
        } catch (RuntimeException e) {
            log.warn("Presence not shared with other instances: Redis unavailable ({})", e.getMessage());
        }
    }

    private static String key(String sessionId, String subscriptionId) {
        return sessionId + "/" + subscriptionId;
    }

    private static String workspaceKey(UUID workspaceId) {
        return "presence:workspace:" + workspaceId;
    }

    private static String instanceKey(String instanceId) {
        return "presence:instance:" + instanceId;
    }

    private static String instanceOf(String field) {
        int slash = field.indexOf('/');
        return slash < 0 ? field : field.substring(0, slash);
    }

    private static String encode(Viewer viewer) {
        return viewer.userId() + "\t" + viewer.displayName();
    }

    private static Viewer decode(String value) {
        int tab = value.indexOf('\t');
        return new Viewer(UUID.fromString(value.substring(0, tab)), value.substring(tab + 1));
    }
}
