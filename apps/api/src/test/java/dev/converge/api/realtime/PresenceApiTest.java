package dev.converge.api.realtime;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;

import dev.converge.api.HttpIntegrationTest;

/** Workspace presence (FR-08): who has the workspace open, counted per person across their tabs. */
class PresenceApiTest extends HttpIntegrationTest {

    @Test
    @SuppressWarnings("unchecked")
    void tabsAreCountedPerPersonAndLeavingIsBroadcast() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect()) {
            String workspace = asha.createWorkspace("Present");
            String topic = "/topic/workspace/" + workspace + "/presence";
            BlockingQueue<Object> updates = asha.subscribeAny(topic);

            Object snapshot = asha.subscribeAny("/app/workspace/" + workspace + "/presence").poll(5, TimeUnit.SECONDS);
            assertThat((List<Map<String, Object>>) snapshot).singleElement()
                    .satisfies(u -> assertThat(u).containsEntry("displayName", "Asha").containsEntry("connections", 1));

            try (var secondTab = asha.secondTab()) {
                secondTab.subscribeAny(topic);
                assertThat(latest(updates)).singleElement().satisfies(u -> assertThat(u).containsEntry("connections", 2));
            }
            assertThat(latest(updates)).singleElement().satisfies(u -> assertThat(u).containsEntry("connections", 1));
        }
    }

    @Test
    void rejectedSubscribersNeverAppearOnline() throws Exception {
        try (var asha = StompTestClient.signUp(port(), "Asha").connect();
                var mallory = StompTestClient.signUp(port(), "Mallory").connect()) {
            String workspace = asha.createWorkspace("Hidden");
            String topic = "/topic/workspace/" + workspace + "/presence";
            BlockingQueue<Object> updates = asha.subscribeAny(topic);
            updates.poll(1, TimeUnit.SECONDS);

            mallory.subscribeAny(topic);

            assertThat(mallory.errors.poll(5, TimeUnit.SECONDS)).isNotNull();
            assertThat(updates.poll(1, TimeUnit.SECONDS)).as("no presence change for a rejected subscriber").isNull();
        }
    }

    /** Waits for the next update and drains any that arrived at the same moment, returning the newest. */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> latest(BlockingQueue<Object> updates) throws InterruptedException {
        Object last = updates.poll(5, TimeUnit.SECONDS);
        assertThat(last).as("a presence update").isNotNull();
        Object more;
        while ((more = updates.poll(300, TimeUnit.MILLISECONDS)) != null) {
            last = more;
        }
        return (List<Map<String, Object>>) last;
    }
}
