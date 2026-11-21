package dev.converge.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
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
        // One instance and no Redis: ClusterBusTest covers sharing events between instances.
        "converge.cluster.enabled=false",
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

    @Test
    void aSessionThatCanNoLongerBeReadSignsThePersonOutInsteadOfFailing() throws Exception {
        String email = "stale-" + UUID.randomUUID() + "@example.test";
        Cookie session = register(email);
        // As after an upgrade that changed a stored class: the bytes no longer deserialize.
        jdbc.sql("""
                update spring_session_attributes set attribute_bytes = decode('aced0005737200156e6f2e737563682e436c617373', 'hex')
                where session_primary_id = (select primary_id from spring_session where principal_name = ?)
                """).param(email).update();

        mvc.perform(get("/api/v1/auth/me").cookie(session)).andExpect(status().isUnauthorized());
    }

    @Test
    void aPersonSeesWhereTheyAreSignedInAndSignsOtherDevicesOut() throws Exception {
        String email = "devices-" + UUID.randomUUID() + "@example.test";
        Cookie laptop = register(email);
        Cookie phone = signIn(email, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
        Cookie desktop = signIn(email, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Converge/0.0.0 Chrome/140.0 Electron/38.0 Safari/537.36");

        String listed = mvc.perform(get("/api/v1/auth/sessions").cookie(phone))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(3))
                .andExpect(jsonPath("$[0].current").value(true))
                .andExpect(jsonPath("$[0].device").value("Safari on iOS"))
                .andExpect(jsonPath("$[?(@.device == 'Converge desktop on Windows')]").exists())
                .andReturn().getResponse().getContentAsString();
        // Nothing listed is a session id, which is what the cookies carry.
        for (Cookie cookie : List.of(laptop, phone, desktop)) {
            String sessionId = new String(java.util.Base64.getDecoder().decode(cookie.getValue()));
            assertThat(listed).doesNotContain(sessionId);
        }

        List<String> desktopIds = com.jayway.jsonpath.JsonPath.read(listed, "$[?(@.device == 'Converge desktop on Windows')].id");
        String phoneId = com.jayway.jsonpath.JsonPath.read(listed, "$[0].id");
        mvc.perform(delete("/api/v1/auth/sessions/" + phoneId).cookie(phone).with(csrf())).andExpect(status().isBadRequest());
        mvc.perform(delete("/api/v1/auth/sessions/" + desktopIds.getFirst()).cookie(phone).with(csrf())).andExpect(status().isNoContent());
        mvc.perform(get("/api/v1/auth/me").cookie(desktop)).andExpect(status().isUnauthorized());

        // Someone else can neither see nor end these sessions.
        Cookie stranger = register("stranger-" + UUID.randomUUID() + "@example.test");
        mvc.perform(delete("/api/v1/auth/sessions/" + phoneId).cookie(stranger).with(csrf())).andExpect(status().isNotFound());

        mvc.perform(post("/api/v1/auth/sessions/sign-out-others").cookie(phone).with(csrf()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.signedOut").value(1));
        mvc.perform(get("/api/v1/auth/me").cookie(laptop)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/auth/me").cookie(phone)).andExpect(status().isOk());
    }

    private Cookie signIn(String email, String userAgent) throws Exception {
        var signedIn = mvc.perform(post("/api/v1/auth/login").with(csrf()).header("User-Agent", userAgent)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"password\":\"correct horse battery\"}"))
                .andExpect(status().isOk())
                .andReturn();
        return sessionCookie(signedIn.getResponse().getHeaders("Set-Cookie"));
    }

    private static Cookie sessionCookie(List<String> setCookies) {
        String setCookie = setCookies.stream().filter(h -> h.startsWith("CONVERGE_SESSION=")).findFirst().orElseThrow();
        return new Cookie("CONVERGE_SESSION", setCookie.substring("CONVERGE_SESSION=".length(), setCookie.indexOf(';')));
    }

    private Cookie register(String email) throws Exception {
        var registered = mvc.perform(post("/api/v1/auth/register").with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"displayName\":\"Asha\",\"password\":\"correct horse battery\"}"))
                .andExpect(status().isCreated())
                .andReturn();
        String setCookie = registered.getResponse().getHeaders("Set-Cookie").stream()
                .filter(h -> h.startsWith("CONVERGE_SESSION=")).findFirst().orElseThrow();
        return new Cookie("CONVERGE_SESSION", setCookie.substring("CONVERGE_SESSION=".length(), setCookie.indexOf(';')));
    }

    private int sessionsOf(String email) {
        return jdbc.sql("select count(*) from spring_session where principal_name = ?").param(email).query(Integer.class).single();
    }
}
