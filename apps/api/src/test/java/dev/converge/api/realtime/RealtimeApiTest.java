package dev.converge.api.realtime;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;

import dev.converge.api.HttpIntegrationTest;

/** The workspace channel end to end: authenticated handshakes, per-destination authorization, delivery. */
class RealtimeApiTest extends HttpIntegrationTest {

    @Test
    void chatIsDeliveredToEveryMemberAndKeptInHistory() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect()) {
            String workspace = asha.createWorkspace("Chatty");
            BlockingQueue<Map<String, Object>> received = asha.subscribe("/topic/workspace/" + workspace + "/chat");

            asha.sendStomp("/app/workspace/" + workspace + "/chat", Map.of("body", "hello team"));

            Map<String, Object> message = received.poll(5, TimeUnit.SECONDS);
            assertThat(message).isNotNull();
            assertThat(message).containsEntry("body", "hello team").containsEntry("displayName", "Asha");
            assertThat(asha.send("GET", "/api/v1/workspaces/" + workspace + "/chat", null, 200)).contains("hello team");
        }
    }

    @Test
    void fileTreeChangesArePublishedAfterCommit() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect()) {
            String workspace = asha.createWorkspace("Evented");
            BlockingQueue<Map<String, Object>> events = asha.subscribe("/topic/workspace/" + workspace + "/events");

            String file = asha.createFile(workspace, "main.go");

            Map<String, Object> event = events.poll(5, TimeUnit.SECONDS);
            assertThat(event).isNotNull().containsEntry("type", "FILE_CREATED").containsEntry("protocolVersion", 1);
            assertThat(event.get("payload").toString()).contains(file);
        }
    }

    @Test
    void outsidersCannotSubscribeToAnotherWorkspace() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect();
                var mallory = StompTestClient.signUp(port(), "Mallory").connect()) {
            String workspace = asha.createWorkspace("Private");
            BlockingQueue<Map<String, Object>> eavesdrop = mallory.subscribe("/topic/workspace/" + workspace + "/chat");

            asha.sendStomp("/app/workspace/" + workspace + "/chat", Map.of("body", "secret plan"));

            assertThat(eavesdrop.poll(2, TimeUnit.SECONDS)).as("nothing reaches a non-member").isNull();
            assertThat(mallory.errors.poll(5, TimeUnit.SECONDS)).as("the server rejects the subscription").isNotNull();
        }
    }

    @Test
    void outsidersCannotPostIntoAnotherWorkspace() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect();
                var mallory = StompTestClient.signUp(port(), "Mallory").connect()) {
            String workspace = asha.createWorkspace("Quiet");
            BlockingQueue<Map<String, Object>> chat = asha.subscribe("/topic/workspace/" + workspace + "/chat");

            mallory.sendStomp("/app/workspace/" + workspace + "/chat", Map.of("body", "spam"));

            assertThat(chat.poll(2, TimeUnit.SECONDS)).isNull();
            assertThat(asha.send("GET", "/api/v1/workspaces/" + workspace + "/chat", null, 200)).doesNotContain("spam");
        }
    }

    @Test
    void crossSiteHandshakesAreRefused() throws Exception {
        var mallory = StompTestClient.signUp(port(), "Mallory");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> mallory.connectFrom("http://evil.example"))
                .as("a page on another origin cannot open a socket with the victim's cookie")
                .isInstanceOf(Exception.class);
    }
}
