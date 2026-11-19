package dev.converge.api.exec;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import dev.converge.api.IntegrationTest;
import dev.converge.api.realtime.InternalTokenFilter;

/** Phase 10 (design §13.7, Gate E): approvals bound to the exact action, single use, first answer wins. */
class ExecutionApiTest extends IntegrationTest {

    private MockHttpSession asha;
    private String workspace;
    private String turn;

    @BeforeEach
    void setUp() throws Exception {
        asha = signUp("Asha");
        workspace = createWorkspace(asha, "Exec");
        perform(asha, put("/api/v1/me/provider-keys/anthropic"), "{'apiKey':'sk-ant-test-0123456789abcdef'}");
        String session = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/sessions"), "{'task':'Test it'}"));
        turn = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'run tests','sessionId':'%s'}", session));
    }

    private ResultActions internal(MockHttpServletRequestBuilder request, String body, Object... args) throws Exception {
        if (body != null) request.contentType(MediaType.APPLICATION_JSON).content(json(body, args));
        return mvc.perform(request.header(InternalTokenFilter.HEADER, INTERNAL_TOKEN));
    }

    private String requestAction(String command) throws Exception {
        return id(internal(post("/internal/agent/turns/{t}/actions", turn), "{'command':'%s'}", command)
                .andExpect(status().isOk()));
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
    void onlyAllowlistedCommandsCanBeRequested() throws Exception {
        internal(post("/internal/agent/turns/{t}/actions", turn), "{'command':'curl http://evil.example'}")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("allowlisted")));
        internal(post("/internal/agent/turns/{t}/actions", turn), "{'command':'npm test && curl x'}")
                .andExpect(status().isBadRequest());
        internal(post("/internal/agent/turns/{t}/actions", turn), "{'command':'node --test ; rm -rf /'}")
                .andExpect(status().isBadRequest());
        requestAction("  npm   test ");
        assertThat(jdbc.sql("select action->>'command' from approvals where workspace_id = ?::uuid").param(workspace).query(String.class).list()).containsExactly("npm test");
    }

    @Test
    void anApprovalIsBoundToTheExactActionAndQueuesOneJob() throws Exception {
        String approval = requestAction("node --test tests/math.test.js");
        getAs(asha, "/api/v1/workspaces/{w}/approvals", workspace)
                .andExpect(jsonPath("$[0].status").value("PENDING"))
                .andExpect(jsonPath("$[0].command").value("node --test tests/math.test.js"))
                .andExpect(jsonPath("$[0].requesterName").value("Asha"))
                .andExpect(jsonPath("$[0].capabilities[0]").value("run a command in the sandbox (no network)"));
        String hash = jdbc.sql("select action_hash from approvals where id = ?::uuid").param(approval).query(String.class).single();
        assertThat(hash).isEqualTo(CommandTemplates.hash(
                "{\"command\":\"node --test tests/math.test.js\",\"kind\":\"run_command\",\"workspaceId\":\"" + workspace + "\"}"));

        MockHttpSession ben = member("EDITOR");
        perform(ben, post("/api/v1/approvals/" + approval + "/decide"), "{'approve':true,'rowVersion':0}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("APPROVED"))
                .andExpect(jsonPath("$.deciderName").value("EDITOR"))
                .andExpect(jsonPath("$.job.status").value("QUEUED"));
        internal(get("/internal/agent/turns/{t}/approvals/{a}", turn, approval), null)
                .andExpect(jsonPath("$.job.command").value("node --test tests/math.test.js"));
    }

    @Test
    void twoAnswersAtOnceRecordExactlyOneDecision() throws Exception {
        String approval = requestAction("npm test");
        MockHttpSession ben = member("EDITOR");
        MockHttpSession cara = member("EDITOR");
        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Future<Integer>> answers = List.of(ben, cara).stream().map(who -> pool.submit(() -> {
                go.await();
                return mvc.perform(post("/api/v1/approvals/{id}/decide", approval).session(who).with(csrf())
                        .contentType(MediaType.APPLICATION_JSON).content(json("{'approve':true,'rowVersion':0}")))
                        .andReturn().getResponse().getStatus();
            })).toList();
            go.countDown();
            assertThat(List.of(answers.get(0).get(), answers.get(1).get())).containsExactlyInAnyOrder(200, 409);
        } finally {
            pool.shutdownNow();
        }
        assertThat(jdbc.sql("select count(*) from jobs where approval_id = ?::uuid").param(approval).query(Integer.class).single())
                .isEqualTo(1);
    }

    @Test
    void viewersCannotAnswerAndDeniedOrExpiredCardsQueueNothing() throws Exception {
        String approval = requestAction("npm test");
        MockHttpSession viewer = member("VIEWER");
        perform(viewer, post("/api/v1/approvals/" + approval + "/decide"), "{'approve':true,'rowVersion':0}")
                .andExpect(status().isForbidden());
        perform(asha, post("/api/v1/approvals/" + approval + "/decide"), "{'approve':false,'rowVersion':0}")
                .andExpect(jsonPath("$.status").value("DENIED"));
        perform(asha, post("/api/v1/approvals/" + approval + "/decide"), "{'approve':true,'rowVersion':1}")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value("This card was already denied"));

        String late = requestAction("npm run lint");
        jdbc.sql("update approvals set expires_at = now() - interval '1 second' where id = ?::uuid").param(late).update();
        perform(asha, post("/api/v1/approvals/" + late + "/decide"), "{'approve':true,'rowVersion':0}")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value("This card was already expired"));
        assertThat(jdbc.sql("select count(*) from jobs where workspace_id = ?::uuid").param(workspace).query(Integer.class).single()).isZero();
    }

    @Test
    void cardsLeftOpenExpireWhenTheTurnEnds() throws Exception {
        String approval = requestAction("npm test");
        internal(post("/internal/agent/turns/{t}/finish", turn), "{'status':'CANCELLED'}");
        getAs(asha, "/api/v1/workspaces/{w}/approvals", workspace).andExpect(jsonPath("$[0].status").value("EXPIRED"));
        perform(asha, post("/api/v1/approvals/" + approval + "/decide"), "{'approve':true,'rowVersion':1}")
                .andExpect(status().isConflict());
    }

    @Test
    void theExecutorReportsOutputAndAnInterruptedJobWaitsForAPersonToRecordTheOutcome() throws Exception {
        String approval = requestAction("npm test");
        perform(asha, post("/api/v1/approvals/" + approval + "/decide"), "{'approve':true,'rowVersion':0}");
        String job = jdbc.sql("select id::text from jobs where approval_id = ?::uuid").param(approval).query(String.class).single();

        internal(post("/internal/jobs/{j}/status", job), "{'status':'RUNNING'}").andExpect(status().isNoContent());
        internal(post("/internal/jobs/{j}/output", job), "{'chunks':[{'stream':'stdout','chunk':'ok 1 adds\\n'},{'stream':'stderr','chunk':'warn\\n'}]}")
                .andExpect(status().isNoContent());
        internal(post("/internal/jobs/{j}/status", job), "{'status':'OUTCOME_UNKNOWN','error':'The executor stopped'}")
                .andExpect(status().isNoContent());
        internal(post("/internal/jobs/{j}/status", job), "{'status':'SUCCEEDED','exitCode':0}")
                .andExpect(status().isConflict()); // never rewritten afterwards, never retried
        internal(get("/internal/agent/turns/{t}/jobs/{j}", turn, job), null)
                .andExpect(jsonPath("$.job.status").value("OUTCOME_UNKNOWN"))
                .andExpect(jsonPath("$.output[0].chunk").value("ok 1 adds\n"))
                .andExpect(jsonPath("$.output[1].stream").value("stderr"));

        perform(asha, post("/api/v1/jobs/" + job + "/outcome"), "{'outcome':'SUCCEEDED'}")
                .andExpect(jsonPath("$.outcome").value("SUCCEEDED"));
        perform(asha, post("/api/v1/jobs/" + job + "/outcome"), "{'outcome':'FAILED'}")
                .andExpect(status().isConflict());
    }

    @Test
    void anEditorCanRunAnAllowlistedCommandDirectly() throws Exception {
        perform(asha, post("/api/v1/workspaces/" + workspace + "/jobs"), "{'command':'npm test'}")
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("APPROVED"))
                .andExpect(jsonPath("$.deciderName").value("Asha"))
                .andExpect(jsonPath("$.job.status").value("QUEUED"));
        MockHttpSession commenter = member("COMMENTER");
        perform(commenter, post("/api/v1/workspaces/" + workspace + "/jobs"), "{'command':'npm test'}")
                .andExpect(status().isForbidden());
    }

    @Test
    void aRunnerCannotReadAnotherTurnsApproval() throws Exception {
        String approval = requestAction("npm test");
        internal(get("/internal/agent/turns/{t}/approvals/{a}", UUID.randomUUID(), approval), null)
                .andExpect(status().isNotFound());
    }
}
