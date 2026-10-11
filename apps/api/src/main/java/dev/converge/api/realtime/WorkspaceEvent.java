package dev.converge.api.realtime;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * The STOMP envelope for workspace events (design §7.3). Published after the database transaction commits,
 * so clients never hear about a change that was rolled back.
 */
public record WorkspaceEvent(String type, UUID workspaceId, UUID eventId, UUID actorId, Instant sentAt,
        Map<String, Object> payload, int protocolVersion) {

    public static WorkspaceEvent of(String type, UUID workspaceId, UUID actorId, Map<String, Object> payload) {
        return new WorkspaceEvent(type, workspaceId, UUID.randomUUID(), actorId, Instant.now(), payload, 1);
    }

    public String topic() {
        return "/topic/workspace/" + workspaceId + "/events";
    }
}
