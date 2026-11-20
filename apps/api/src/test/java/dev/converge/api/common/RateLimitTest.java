package dev.converge.api.common;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;

import dev.converge.api.IntegrationTest;
import dev.converge.api.realtime.InternalTokenFilter;

/** Phase 13 (design §14, §16): rate limits backed by Redis, and metrics only for the monitoring network. */
@TestPropertySource(properties = "converge.rate-limits.scale=1")
class RateLimitTest extends IntegrationTest {

    @ServiceConnection(name = "redis")
    static final GenericContainer<?> REDIS = new GenericContainer<>(DockerImageName.parse("redis:8-alpine")).withExposedPorts(6379);

    static {
        REDIS.start();
    }

    @Test
    void repeatedFailedSignInsAreSlowedDown() throws Exception {
        String email = "target-" + UUID.randomUUID() + "@example.test";
        for (int i = 0; i < RateLimiter.LOGIN.max(); i++) {
            mvc.perform(post("/api/v1/auth/login").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                            .content(json("{'email':'%s','password':'wrong password %d'}", email, i)))
                    .andExpect(status().isUnauthorized());
        }
        mvc.perform(post("/api/v1/auth/login").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'%s','password':'wrong again'}", email)))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().string("Retry-After", Matchers.matchesPattern("\\d+")));
    }

    @Test
    void metricsNeedTheInternalToken() throws Exception {
        mvc.perform(get("/api/actuator/prometheus")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/actuator/prometheus").header(InternalTokenFilter.HEADER, INTERNAL_TOKEN))
                .andExpect(status().isOk())
                .andExpect(content().string(Matchers.containsString("agent_turns_running")))
                .andExpect(content().string(Matchers.containsString("job_queue_depth")));
    }
}
