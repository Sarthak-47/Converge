package dev.converge.api;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.client.RestClient;

import dev.converge.api.agent.AgentRunnerClient;
import dev.converge.api.realtime.CollabClient;

/**
 * The service clients are mocked in the other tests, so their constructors never run there. This builds the
 * real ones from the context's beans: a missing dependency (as RestClient.Builder once was) fails here, not
 * when the stack starts.
 */
class WiringTest extends IntegrationTest {

    @Autowired
    private RestClient.Builder builder;

    @Value("${converge.internal-token}")
    private String internalToken;

    @Test
    void theRealServiceClientsCanBeBuilt() {
        assertThat(new CollabClient(builder, "http://collab:1234", internalToken)).isNotNull();
        assertThat(new AgentRunnerClient(builder, "http://agent-runner:4100", internalToken)).isNotNull();
    }
}
