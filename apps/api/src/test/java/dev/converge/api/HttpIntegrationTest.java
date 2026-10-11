package dev.converge.api;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;

/**
 * Like {@link IntegrationTest}, but with the real server listening on a random port, for tests that must go
 * through real HTTP: cookies, CSRF filters and WebSocket handshakes behave exactly as they do for a browser.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "converge.collab.health.enabled=false",
        "management.health.redis.enabled=false"
})
public abstract class HttpIntegrationTest extends IntegrationTest {

    @Autowired
    private Environment environment;

    protected int port() {
        return environment.getRequiredProperty("local.server.port", Integer.class);
    }
}
