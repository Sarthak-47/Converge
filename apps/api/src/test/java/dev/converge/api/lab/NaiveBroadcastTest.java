package dev.converge.api.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import dev.converge.api.HttpIntegrationTest;
import dev.converge.api.realtime.StompTestClient;

/**
 * Reproduces the bug that motivates the CRDT-based editor (design §8.1). Both users start from "hello". Asha
 * inserts " A", Ben inserts " B", each sending their whole document. The relay keeps whichever arrived last,
 * so one person's edit is silently lost. This test passes because the bug is real; the Yjs end-to-end tests
 * show both edits kept.
 */
class NaiveBroadcastTest extends HttpIntegrationTest {

    @Autowired
    NaiveBroadcast relay;

    @Test
    void wholeDocumentBroadcastLosesAConcurrentEdit() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect()) {
            String workspace = asha.createWorkspace("Naive");
            String file = asha.createFile(workspace, "doc.txt");
            BlockingQueue<Map<String, Object>> updates = asha.subscribe("/topic/file/" + file + "/naive");

            String base = "hello";
            asha.sendStomp("/app/file/" + file + "/naive", Map.of("clientId", "asha", "text", base + " A"));
            asha.sendStomp("/app/file/" + file + "/naive", Map.of("clientId", "ben", "text", base + " B"));

            assertThat(updates.poll(5, TimeUnit.SECONDS)).isNotNull();
            assertThat(updates.poll(5, TimeUnit.SECONDS)).isNotNull();
            String finalText = relay.current(java.util.UUID.fromString(file));

            // Inbound STOMP messages are handled on a thread pool, so either edit may arrive last.
            // Whichever does, the other is silently discarded: that is the lost-update problem.
            assertThat(finalText).isIn("hello A", "hello B");
        }
    }
}
