package dev.converge.api;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.postgresql.PostgreSQLContainer;

import dev.converge.api.realtime.CollabClient;

/**
 * Base for tests that exercise the real HTTP API against a real PostgreSQL. One container is shared by all
 * test classes; each test creates its own users and workspaces, so tests never depend on each other.
 */
@SpringBootTest(properties = {
        "converge.collab.health.enabled=false",
        "management.health.redis.enabled=false",
        "converge.internal-token=" + IntegrationTest.INTERNAL_TOKEN
})
@AutoConfigureMockMvc
public abstract class IntegrationTest {

    public static final String INTERNAL_TOKEN = "test-internal-token";

    @ServiceConnection
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18-alpine");

    static {
        POSTGRES.start();
    }

    @Autowired
    protected MockMvc mvc;

    @Autowired
    protected JdbcClient jdbc;

    /** Stands in for the collaboration service, storing text exactly as its store hook does. */
    @MockitoBean
    protected CollabClient collab;

    @BeforeEach
    void simulateCollaborationService() {
        doAnswer(call -> {
            UUID fileId = call.getArgument(0);
            String text = call.getArgument(1);
            String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
            jdbc.sql("update documents set text_content = ?, content_hash = ?, content_version = content_version + 1 where file_id = ?")
                    .params(text, hash, fileId)
                    .update();
            return null;
        }).when(collab).applyText(any(), any(), any());
    }

    /** Registers a fresh user and returns their signed-in session. */
    protected MockHttpSession signUp(String name) throws Exception {
        String email = name.toLowerCase() + "-" + UUID.randomUUID() + "@example.test";
        var result = mvc.perform(post("/api/v1/auth/register").with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'%s','displayName':'%s','password':'correct horse battery'}", email, name)))
                .andExpect(status().isCreated())
                .andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }

    protected String createWorkspace(MockHttpSession session, String name) throws Exception {
        return id(perform(session, post("/api/v1/workspaces"), "{'name':'%s'}", name).andExpect(status().isCreated()));
    }

    protected ResultActions createFile(MockHttpSession session, String workspaceId, String parentId, String name,
            String kind) throws Exception {
        String parent = parentId == null ? "null" : "'" + parentId + "'";
        return perform(session, post("/api/v1/files"),
                "{'workspaceId':'%s','parentId':%s,'name':'%s','kind':'%s'}", workspaceId, parent, name, kind);
    }

    protected ResultActions perform(MockHttpSession session, MockHttpServletRequestBuilder request, String body,
            Object... args) throws Exception {
        return mvc.perform(request.session(session).with(csrf())
                .contentType(MediaType.APPLICATION_JSON)
                .content(json(body, args)));
    }

    protected ResultActions getAs(MockHttpSession session, String url, Object... args) throws Exception {
        return mvc.perform(get(url, args).session(session));
    }

    protected static String id(ResultActions actions) throws Exception {
        return JsonPath.read(actions.andReturn().getResponse().getContentAsString(), "$.id");
    }

    protected static <T> T read(ResultActions actions, String path) throws Exception {
        return JsonPath.read(actions.andReturn().getResponse().getContentAsString(), path);
    }

    /** Lets tests write JSON with single quotes for readability. */
    protected static String json(String template, Object... args) {
        return String.format(template, args).replace('\'', '"');
    }
}
