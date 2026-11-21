package dev.converge.api.realtime;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Lazy;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.messaging.converter.MessageConverter;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageType;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.util.MimeTypeUtils;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Lets several API instances serve one workspace channel (design §7.5). Every instance keeps its own STOMP
 * broker for the sockets connected to it; whatever one instance sends to a topic, or a "close this person's
 * sockets" order, is also published on a Redis channel, and every other instance repeats it to its own
 * sockets. A payload is converted to bytes once, with the broker's own converter, so clients receive
 * identical frames whichever instance they are connected to.
 *
 * Delivery to this instance's sockets never waits for Redis. When Redis is down, each instance still serves
 * its own clients, as with one instance; clients on other instances miss those events until it is back.
 */
@Component
public class ClusterBus implements MessageListener {

    public static final String CHANNEL = "converge:realtime";
    private static final Logger log = LoggerFactory.getLogger(ClusterBus.class);

    private final String instanceId = UUID.randomUUID().toString();
    private final StringRedisTemplate redis;
    private final SimpMessagingTemplate messaging;
    private final MessageConverter converter;
    private final WebSocketSessions sessions;
    private final JsonMapper json = JsonMapper.builder().build();
    private final boolean enabled;

    public ClusterBus(StringRedisTemplate redis, @Lazy SimpMessagingTemplate messaging,
            @Lazy @Qualifier("brokerMessageConverter") MessageConverter converter, WebSocketSessions sessions,
            @Value("${converge.cluster.enabled:true}") boolean enabled) {
        this.redis = redis;
        this.messaging = messaging;
        this.converter = converter;
        this.sessions = sessions;
        this.enabled = enabled;
    }

    /** False when this API runs alone and shares nothing through Redis (converge.cluster.enabled). */
    public boolean enabled() {
        return enabled;
    }

    /** This instance's id: presence entries carry it, so another instance's sockets are told apart. */
    public String instanceId() {
        return instanceId;
    }

    /** Sends a payload to a topic on every instance. */
    public void send(String destination, Object payload) {
        byte[] body = (byte[]) converter.toMessage(payload, null).getPayload();
        deliver(destination, body);
        publish(Map.of("type", "send", "from", instanceId, "destination", destination,
                "body", new String(body, StandardCharsets.UTF_8)));
    }

    /** Closes a person's workspace-channel sockets on every instance (their access was taken away). */
    public void closeUser(UUID userId, CloseStatus status) {
        sessions.closeAll(userId, status);
        publish(Map.of("type", "close", "from", instanceId, "userId", userId.toString(), "code", status.getCode(),
                "reason", status.getReason() == null ? "" : status.getReason()));
    }

    /**
     * Sends ready-made JSON bytes to this instance's subscribers. Built by hand rather than through
     * convertAndSend: the converters would see a byte array labelled JSON and encode it again, as a string.
     */
    private void deliver(String destination, byte[] body) {
        SimpMessageHeaderAccessor headers = SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
        headers.setContentType(MimeTypeUtils.APPLICATION_JSON);
        headers.setLeaveMutable(true);
        messaging.send(destination, MessageBuilder.createMessage(body, headers.getMessageHeaders()));
    }

    private void publish(Map<String, Object> envelope) {
        if (!enabled) return;
        try {
            redis.convertAndSend(CHANNEL, json.writeValueAsString(envelope));
        } catch (RuntimeException e) {
            log.warn("Realtime event not shared with other instances: Redis unavailable ({})", e.getMessage());
        }
    }

    /** Another instance's event: repeated to this instance's sockets. */
    @Override
    public void onMessage(Message message, byte[] pattern) {
        try {
            JsonNode envelope = json.readTree(message.getBody());
            if (instanceId.equals(envelope.path("from").asString())) return;
            switch (envelope.path("type").asString()) {
                case "send" -> deliver(envelope.path("destination").asString(),
                        envelope.path("body").asString().getBytes(StandardCharsets.UTF_8));
                case "close" -> sessions.closeAll(UUID.fromString(envelope.path("userId").asString()),
                        new CloseStatus(envelope.path("code").asInt(), envelope.path("reason").asString()));
                default -> log.warn("Ignoring an unknown realtime event type {}", envelope.path("type").asString());
            }
        } catch (RuntimeException e) {
            log.warn("Could not apply a realtime event from another instance: {}", e.getMessage());
        }
    }
}
