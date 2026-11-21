package dev.converge.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import jakarta.servlet.http.Cookie;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.postgresql.PostgreSQLContainer;

import dev.converge.api.agent.AgentRunnerClient;
import dev.converge.api.realtime.CollabClient;

/**
 * Signed-in sessions live in PostgreSQL (Spring Session), not in the API's memory, so a restart or a second
 * instance keeps everyone signed in. Only the session cookie is sent, as a browser would.
 */
@SpringBootTest(properties = {
        "converge.collab.health.enabled=false",
        "management.health.redis.enabled=false",
        "converge.internal-token=" + IntegrationTest.INTERNAL_TOKEN,
        "converge.secrets-key=" + IntegrationTest.SECRETS_KEY,
        "converge.rate-limits.scale=0"
})
@AutoConfigureMockMvc
class SharedSessionTest {

    @ServiceConnection
    static final PostgreSQLContainer POSTGRES = IntegrationTest.POSTGRES;

    @Autowired
    MockMvc mvc;

    @Autowired
    JdbcClient jdbc;

    @MockitoBean
    CollabClient collab;

    @MockitoBean
    AgentRunnerClient agentRunner;

    @Test
    void aSessionIsAStoredRowThatOnlyItsCookieOpensAndSignOutRemoves() throws Exception {
        String email = "shared-" + UUID.randomUUID() + "@example.test";
        var registered = mvc.perform(post("/api/v1/auth/register").with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"displayName\":\"Asha\",\"password\":\"correct horse battery\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        // Spring Session writes the header itself rather than through addCookie.
        String setCookie = registered.getResponse().getHeaders("Set-Cookie").stream()
                .filter(h -> h.startsWith("CONVERGE_SESSION=")).findFirst().orElseThrow();
        assertThat(setCookie).contains("HttpOnly").contains("SameSite=Lax");
        Cookie session = new Cookie("CONVERGE_SESSION", setCookie.substring("CONVERGE_SESSION=".length(), setCookie.indexOf(';')));

        // The session is a row, keyed to the person, with nothing of the password in it.
        assertThat(sessionsOf(email)).isEqualTo(1);
        assertThat(jdbc.sql("select max_inactive_interval from spring_session where principal_name = ?").param(email)
                .query(Integer.class).single()).isEqualTo(12 * 60 * 60);
        String attributes = jdbc.sql("""
                select string_agg(encode(a.attribute_bytes, 'escape'), '') from spring_session_attributes a
                join spring_session s on s.primary_id = a.session_primary_id where s.principal_name = ?
                """).param(email).query(String.class).single();
        assertThat(attributes).doesNotContain("$2a$").doesNotContain("correct horse battery");

        // Any instance that can read the table opens it from the cookie alone.
        mvc.perform(get("/api/v1/auth/me").cookie(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.email").value(email));
        mvc.perform(get("/api/v1/auth/me")).andExpect(status().isUnauthorized());

        mvc.perform(post("/api/v1/auth/logout").cookie(session).with(csrf())).andExpect(status().isNoContent());
        assertThat(sessionsOf(email)).isZero();
        mvc.perform(get("/api/v1/auth/me").cookie(session)).andExpect(status().isUnauthorized());
    }

    private int sessionsOf(String email) {
        return jdbc.sql("select count(*) from spring_session where principal_name = ?").param(email).query(Integer.class).single();
    }
}
