package dev.converge.api.realtime;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.test.context.TestPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;

import dev.converge.api.HttpIntegrationTest;

/**
 * Several API instances on one workspace channel (design §7.5). This test is one instance; it plays the other
 * one by reading and writing the shared Redis channel and presence keys directly.
 */
@TestPropertySource(properties = "converge.cluster.enabled=true")
class ClusterBusTest extends HttpIntegrationTest {

    @ServiceConnection(name = "redis")
    static final GenericContainer<?> REDIS = new GenericContainer<>(DockerImageName.parse("redis:8-alpine")).withExposedPorts(6379);

    static {
        REDIS.start();
    }

    @Autowired
    StringRedisTemplate redis;

    @Autowired
    RedisConnectionFactory connections;

    private final BlockingQueue<String> published = new LinkedBlockingQueue<>();
    private RedisMessageListenerContainer otherInstance;

    @BeforeEach
    void listenAsAnotherInstance() throws Exception {
        otherInstance = new RedisMessageListenerContainer();
        otherInstance.setConnectionFactory(connections);
        otherInstance.addMessageListener((message, pattern) -> published.add(new String(message.getBody())), new ChannelTopic(ClusterBus.CHANNEL));
        otherInstance.afterPropertiesSet();
        otherInstance.start();
        Thread.sleep(300); // the subscription is confirmed asynchronously
    }

    @AfterEach
    void stopListening() throws Exception {
        otherInstance.destroy();
    }

    @Test
    void whatThisInstanceSendsIsSharedAndWhatAnotherSendsIsDelivered() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect()) {
            String workspace = asha.createWorkspace("Clustered");
            BlockingQueue<Map<String, Object>> chat = asha.subscribe("/topic/workspace/" + workspace + "/chat");

            asha.sendStomp("/app/workspace/" + workspace + "/chat", Map.of("body", "from this instance"));
            assertThat(chat.poll(5, TimeUnit.SECONDS)).containsEntry("body", "from this instance");
            String envelope = awaitPublished("from this instance");
            assertThat(envelope).contains("\"type\":\"send\"", "/topic/workspace/" + workspace + "/chat");

            // A chat message sent through another instance reaches this instance's subscriber, byte for byte.
            String body = "{\"id\":\"" + UUID.randomUUID() + "\",\"body\":\"from the other instance\",\"displayName\":\"Ben\"}";
            redis.convertAndSend(ClusterBus.CHANNEL, "{\"type\":\"send\",\"from\":\"other\",\"destination\":\"/topic/workspace/"
                    + workspace + "/chat\",\"body\":" + quote(body) + "}");
            assertThat(chat.poll(5, TimeUnit.SECONDS)).containsEntry("body", "from the other instance").containsEntry("displayName", "Ben");
        }
    }

    @Test
    void anOrderToCloseSomeonesSocketsReachesThisInstance() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect()) {
            String userId = asha.send("GET", "/api/v1/auth/me", null, 200).replaceAll(".*\"id\":\"([^\"]+)\".*", "$1");
            redis.convertAndSend(ClusterBus.CHANNEL, "{\"type\":\"close\",\"from\":\"other\",\"userId\":\"" + userId
                    + "\",\"code\":4403,\"reason\":\"Workspace access removed\"}");
            long deadline = System.currentTimeMillis() + 5000;
            while (asha.isConnected() && System.currentTimeMillis() < deadline) Thread.sleep(50);
            assertThat(asha.isConnected()).isFalse();
        }
    }

    @Test
    void presenceCountsViewersOfLiveInstancesOnly() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect()) {
            String workspace = asha.createWorkspace("Seen");
            asha.subscribeList("/topic/workspace/" + workspace + "/presence"); // Asha is online through this instance
            // Ben has the workspace open through another, live instance.
            UUID ben = UUID.randomUUID();
            redis.opsForValue().set("presence:instance:other", "1", Duration.ofSeconds(30));
            redis.opsForHash().put("presence:workspace:" + workspace, "other/s1/sub-0", ben + "\tBen");

            List<Map<String, Object>> online = asha.subscribeList("/app/workspace/" + workspace + "/presence").poll(5, TimeUnit.SECONDS);
            assertThat(online).extracting(u -> u.get("displayName")).containsExactly("Asha", "Ben");

            // That instance stopped without a word: once its key expires, Ben is no longer counted.
            redis.delete("presence:instance:other");
            online = asha.subscribeList("/app/workspace/" + workspace + "/presence").poll(5, TimeUnit.SECONDS);
            assertThat(online).extracting(u -> u.get("displayName")).containsExactly("Asha");
            assertThat(redis.opsForHash().hasKey("presence:workspace:" + workspace, "other/s1/sub-0")).isFalse();
        }
    }

    private String awaitPublished(String text) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            String next = published.poll(200, TimeUnit.MILLISECONDS);
            if (next != null && next.contains(text)) return next;
        }
        throw new AssertionError("Nothing containing \"" + text + "\" was published to other instances");
    }

    private static String quote(String json) {
        return "\"" + json.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }
}
