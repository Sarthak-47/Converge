package dev.converge.api.git;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;

import dev.converge.api.IntegrationTest;
import dev.converge.api.realtime.InternalTokenFilter;

/** Phase 12 (design §10): connecting a repository and queuing Git operations for the worker. */
class GitApiTest extends IntegrationTest {

    private static final String TOKEN = "ghp_0123456789abcdefWXYZ";

    private MockHttpSession asha;
    private String workspace;

    @BeforeEach
    void setUp() throws Exception {
        asha = signUp("Asha");
        workspace = createWorkspace(asha, "Git");
    }

    private void connect() throws Exception {
        perform(asha, put("/api/v1/workspaces/" + workspace + "/git"),
                "{'remoteUrl':'https://github.com/acme/app.git','defaultBranch':'main','token':'%s'}", TOKEN)
                .andExpect(status().isOk());
    }

    private MockHttpSession member(String role) throws Exception {
        String email = role.toLowerCase() + "-" + UUID.randomUUID() + "@example.test";
        var result = mvc.perform(post("/api/v1/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'%s','displayName':'%s','password':'correct horse battery'}", email, role)))
                .andExpect(status().isCreated()).andReturn();
        perform(asha, post("/api/v1/workspaces/" + workspace + "/members"), "{'email':'%s','role':'%s'}", email, role);
        return (MockHttpSession) result.getRequest().getSession(false);
    }

    @Test
    void onlyOwnersConnectAndTheTokenNeverLeavesTheServer() throws Exception {
        MockHttpSession ben = member("EDITOR");
        perform(ben, put("/api/v1/workspaces/" + workspace + "/git"),
                "{'remoteUrl':'https://github.com/acme/app.git','token':'%s'}", TOKEN).andExpect(status().isForbidden());
        perform(asha, put("/api/v1/workspaces/" + workspace + "/git"),
                "{'remoteUrl':'http://github.com/acme/app.git','token':'%s'}", TOKEN).andExpect(status().isBadRequest());
        perform(asha, put("/api/v1/workspaces/" + workspace + "/git"),
                "{'remoteUrl':'file:///etc/passwd','token':'%s'}", TOKEN).andExpect(status().isBadRequest());
        perform(asha, put("/api/v1/workspaces/" + workspace + "/git"),
                "{'remoteUrl':'https://github.com/acme/app.git','defaultBranch':'../x','token':'%s'}", TOKEN).andExpect(status().isBadRequest());

        connect();
        String body = getAs(ben, "/api/v1/workspaces/{w}/git", workspace)
                .andExpect(jsonPath("$.owner").value("acme"))
                .andExpect(jsonPath("$.repo").value("app"))
                .andExpect(jsonPath("$.credentialHint").value("…WXYZ"))
                .andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain(TOKEN);
        byte[] stored = jdbc.sql("select credential from git_repositories where workspace_id = ?::uuid").param(workspace)
                .query(byte[].class).single();
        assertThat(new String(stored, StandardCharsets.ISO_8859_1)).doesNotContain("ghp_");

        mvc.perform(delete("/api/v1/workspaces/{w}/git", workspace).session(asha).with(csrf())).andExpect(status().isNoContent());
        getAs(asha, "/api/v1/workspaces/{w}/git", workspace).andExpect(status().isNoContent());
    }

    @Test
    void aSessionsDriverQueuesOnePullRequestPerIdempotencyKey() throws Exception {
        String session = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/sessions"), "{'task':'Add input validation!'}"));
        perform(asha, post("/api/v1/sessions/" + session + "/steps"), "{'titles':['Validate email']}");
        perform(asha, post("/api/v1/sessions/" + session + "/pull-request"), "{'idempotencyKey':'k1'}")
                .andExpect(status().isConflict()); // not connected yet
        connect();

        MockHttpSession ben = member("EDITOR");
        perform(ben, post("/api/v1/sessions/" + session + "/pull-request"), "{'idempotencyKey':'k1'}")
                .andExpect(status().isForbidden());
        String op = id(perform(asha, post("/api/v1/sessions/" + session + "/pull-request"), "{'idempotencyKey':'k1'}")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andExpect(jsonPath("$.type").value("PULL_REQUEST"))
                .andExpect(jsonPath("$.params.branch").value("converge/add-input-validation-" + session.substring(0, 8)))
                .andExpect(jsonPath("$.params.title").value("Add input validation!"))
                .andExpect(jsonPath("$.params.body").value(org.hamcrest.Matchers.containsString("- [ ] Validate email"))));
        // A retry with the same key returns the same operation instead of pushing twice.
        perform(asha, post("/api/v1/sessions/" + session + "/pull-request"), "{'idempotencyKey':'k1'}")
                .andExpect(jsonPath("$.id").value(op));
        getAs(ben, "/api/v1/workspaces/{w}/git/operations?sessionId={s}", workspace, session)
                .andExpect(jsonPath("$.length()").value(1));

        mvc.perform(post("/internal/git/operations/{id}/notify", op).header(InternalTokenFilter.HEADER, INTERNAL_TOKEN)
                .contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isNoContent());
    }

    @Test
    void editorsPushBranchesWithValidNames() throws Exception {
        connect();
        MockHttpSession cleo = member("COMMENTER");
        perform(cleo, post("/api/v1/workspaces/" + workspace + "/git/pushes"), "{'idempotencyKey':'p','branch':'feature/x','message':'m'}")
                .andExpect(status().isForbidden());
        perform(asha, post("/api/v1/workspaces/" + workspace + "/git/pushes"), "{'idempotencyKey':'p','branch':'bad..name','message':'m'}")
                .andExpect(status().isBadRequest());
        perform(asha, post("/api/v1/workspaces/" + workspace + "/git/pushes"), "{'idempotencyKey':'p','branch':'feature/login','message':'Add login'}")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.params.branch").value("feature/login"));
    }

    @Test
    void anImportCreatesNewFilesAndMergesChangedOnesAsTheRequester() throws Exception {
        connect();
        String existing = id(createFile(asha, workspace, null, "README.md", "FILE"));
        String op = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/git/pulls"), "{'idempotencyKey':'pull-1'}")
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.type").value("PULL"))
                .andExpect(jsonPath("$.params.branch").value("main")));
        // The worker would have claimed it.
        jdbc.sql("update git_operations set status = 'RUNNING' where id = ?::uuid").param(op).update();

        mvc.perform(post("/internal/git/operations/{id}/import", op).header(InternalTokenFilter.HEADER, INTERNAL_TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'files':[{'path':'README.md','text':'# from git\\n'},{'path':'src/app/main.ts','text':'export {}\\n'},{'path':'bad/../x','text':'x'}]}")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.created").value(1))
                .andExpect(jsonPath("$.updated").value(1))
                .andExpect(jsonPath("$.refused.length()").value(1));
        // The changed file went through apply-text (the collaboration service), as an external change.
        org.mockito.Mockito.verify(collab, org.mockito.Mockito.atLeastOnce())
                .applyText(org.mockito.ArgumentMatchers.eq(UUID.fromString(existing)), org.mockito.ArgumentMatchers.eq("# from git\n"), org.mockito.ArgumentMatchers.anyString());
        getAs(asha, "/api/v1/workspaces/{w}/tree", workspace)
                .andExpect(jsonPath("$[?(@.path == 'src/app/main.ts')]").exists());
    }
    private org.springframework.test.web.servlet.ResultActions deliver(String event, String delivery, String secret, String body)
            throws Exception {
        javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = "sha256=" + java.util.HexFormat.of().formatHex(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
        return mvc.perform(post("/api/v1/git/webhooks/" + workspace)
                .header("X-GitHub-Event", event).header("X-GitHub-Delivery", delivery)
                .header("X-Hub-Signature-256", signature)
                .contentType(MediaType.APPLICATION_JSON).content(body));
    }

    @Test
    void aSignedPushToTheDefaultBranchImportsItOnceAndNothingElseDoes() throws Exception {
        connect();
        MockHttpSession ben = member("EDITOR");
        perform(ben, post("/api/v1/workspaces/" + workspace + "/git/webhook"), "{}").andExpect(status().isForbidden());
        var enabled = perform(asha, post("/api/v1/workspaces/" + workspace + "/git/webhook"), "{}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.path").value("/api/v1/git/webhooks/" + workspace));
        String secret = read(enabled, "$.secret");
        getAs(asha, "/api/v1/workspaces/{id}/git", workspace).andExpect(jsonPath("$.webhook").value(true));

        String push = "{\"ref\":\"refs/heads/main\"}";
        // Anything not signed with the secret is indistinguishable from a workspace without a webhook.
        deliver("push", "d-0", "wrong-secret", push).andExpect(status().isNotFound());
        deliver("ping", "d-1", secret, "{}").andExpect(status().isOk()).andExpect(jsonPath("$.result").value("ping"));
        deliver("push", "d-2", secret, "{\"ref\":\"refs/heads/feature\"}").andExpect(jsonPath("$.result").value("ignored"));
        deliver("push", "d-3", secret, push).andExpect(status().isAccepted()).andExpect(jsonPath("$.result").value("queued"));
        // GitHub redelivers on timeouts; the same delivery never imports twice.
        deliver("push", "d-3", secret, push).andExpect(status().isAccepted());
        getAs(asha, "/api/v1/workspaces/{id}/git/operations", workspace)
                .andExpect(jsonPath("$[?(@.type == 'PULL')]").value(org.hamcrest.Matchers.hasSize(1)));

        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .delete("/api/v1/workspaces/" + workspace + "/git/webhook").session(asha).with(csrf()))
                .andExpect(status().isNoContent());
        deliver("push", "d-4", secret, push).andExpect(status().isNotFound());
    }
}
