package dev.converge.api.health;

import java.net.http.HttpClient;
import java.time.Duration;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.health.contributor.AbstractHealthIndicator;
import org.springframework.boot.health.contributor.Health;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * Reports whether the collaboration service is reachable and healthy, so the API's
 * health endpoint covers every component a document edit depends on.
 */
@Component("collab")
@ConditionalOnBooleanProperty(name = "converge.collab.health.enabled", matchIfMissing = true)
public class CollabHealthIndicator extends AbstractHealthIndicator {

    private static final Duration TIMEOUT = Duration.ofSeconds(2);

    private final RestClient client;

    public CollabHealthIndicator(@Value("${converge.collab.base-url}") String baseUrl) {
        super("Collaboration service health check failed");
        // HTTP/1.1 only: the JDK client's default HTTP/2 attempt sends "Upgrade: h2c", which the
        // collaboration server treats as a malformed WebSocket upgrade and rejects with 400.
        HttpClient httpClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(TIMEOUT)
                .build();
        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(httpClient);
        requestFactory.setReadTimeout(TIMEOUT);
        this.client = RestClient.builder().baseUrl(baseUrl).requestFactory(requestFactory).build();
    }

    @Override
    protected void doHealthCheck(Health.Builder builder) {
        // Non-2xx responses (collab reports 503 when its own dependencies are down) throw,
        // which AbstractHealthIndicator turns into DOWN with the exception attached.
        String body = client.get().uri("/health").retrieve().body(String.class);
        builder.up().withDetail("response", body);
    }
}
