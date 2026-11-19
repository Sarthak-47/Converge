package dev.converge.api.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
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
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import dev.converge.api.IntegrationTest;
import dev.converge.api.agent.AgentRunnerClient.StartTurn;
import dev.converge.api.realtime.InternalTokenFilter;

/** Phase 9 (design §13.3, §13.8, §13.9): sessions, takeover races, plans with owners, comments. */
class SessionApiTest extends IntegrationTest {

    private static final String KEY = "sk-ant-test-0123456789abcdef";

    private MockHttpSession asha;
    private String workspace;
    private String file;

    @BeforeEach
    void setUp() throws Exception {
        asha = signUp("Asha");
        workspace = createWorkspace(asha, "Sessions");
        file = id(createFile(asha, workspace, null, "signup.ts", "FILE"));
        setKey(asha);
    }

    private void setKey(MockHttpSession session) throws Exception {
        perform(session, put("/api/v1/me/provider-keys/anthropic"), "{'apiKey':'%s'}", KEY).andExpect(status().isOk());
    }

    private record Member(MockHttpSession session, String id) {
    }

    private Member member(String name, String role) throws Exception {
        String email = name.toLowerCase() + "-" + UUID.randomUUID() + "@example.test";
        var result = mvc.perform(post("/api/v1/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'%s','displayName':'%s','password':'correct horse battery'}", email, name)))
                .andExpect(status().isCreated()).andReturn();
        String id = com.jayway.jsonpath.JsonPath.read(result.getResponse().getContentAsString(), "$.id");
        perform(asha, post("/api/v1/workspaces/" + workspace + "/members"), "{'email':'%s','role':'%s'}", email, role)
                .andExpect(status().is2xxSuccessful());
        return new Member((MockHttpSession) result.getRequest().getSession(false), id);
    }

    private String session(String task) throws Exception {
        return id(perform(asha, post("/api/v1/workspaces/" + workspace + "/sessions"), "{'task':'%s'}", task)
                .andExpect(status().isCreated()));
    }

    private int rowVersion(MockHttpSession who, String session) throws Exception {
        return read(getAs(who, "/api/v1/sessions/{id}", session), "$.session.rowVersion");
    }

    private ResultActions internal(MockHttpServletRequestBuilder request, String body, Object... args) throws Exception {
        if (body != null) request.contentType(MediaType.APPLICATION_JSON).content(json(body, args));
        return mvc.perform(request.header(InternalTokenFilter.HEADER, INTERNAL_TOKEN));
    }

    private String prompt(MockHttpSession who, String session, String text) throws Exception {
        return id(perform(who, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'%s','sessionId':'%s'}", text, session)
                .andExpect(status().isCreated()));
    }

    @Test
    void twoMembersAgentsWorkOneSessionAndTheBoardShowsIt() throws Exception {
        String session = session("Add input validation to signup");
        Member ben = member("Ben", "EDITOR");
        setKey(ben.session());

        String ashaTurn = prompt(asha, session, "validate email");
        String benTurn = prompt(ben.session(), session, "write tests");
        ArgumentCaptor<StartTurn> started = ArgumentCaptor.forClass(StartTurn.class);
        verify(agentRunner, times(2)).start(started.capture());
        assertThat(started.getAllValues()).allSatisfy(t -> {
            assertThat(t.session().id().toString()).isEqualTo(session);
            assertThat(t.session().task()).isEqualTo("Add input validation to signup");
        });
        internal(put("/internal/agent/turns/{t}/files/{f}/revert-state", ashaTurn, file),
                "{'state':'AAEC','undo':{'insertions':{},'deletions':{}}}");

        getAs(asha, "/api/v1/workspaces/{w}/sessions", workspace)
                .andExpect(jsonPath("$[0].task").value("Add input validation to signup"))
                .andExpect(jsonPath("$[0].driverName").value("Asha"))
                .andExpect(jsonPath("$[0].runningTurns").value(2))
                .andExpect(jsonPath("$[0].participants.length()").value(2))
                .andExpect(jsonPath("$[0].files[0]").value("signup.ts"));
        getAs(ben.session(), "/api/v1/sessions/{id}", session)
                .andExpect(jsonPath("$.turns.length()").value(2))
                .andExpect(jsonPath("$.turns[1].id").value(benTurn));
    }

    @Test
    void aTakeoverRaceHasExactlyOneWinner() throws Exception {
        String session = session("Refactor auth");
        prompt(asha, session, "start");
        Member ben = member("Ben", "EDITOR");
        Member cara = member("Cara", "EDITOR");
        setKey(ben.session());
        setKey(cara.session());
        int version = rowVersion(asha, session);
        when(agentRunner.cancel(any())).thenReturn(true);

        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Future<Integer>> results = List.of(ben, cara).stream().map(m -> pool.submit(() -> {
                go.await();
                return mvc.perform(post("/api/v1/sessions/{id}/takeover", session).session(m.session()).with(csrf())
                                .contentType(MediaType.APPLICATION_JSON).content(json("{'rowVersion':%d}", version)))
                        .andReturn().getResponse().getStatus();
            })).toList();
            go.countDown();
            List<Integer> statuses = List.of(results.get(0).get(), results.get(1).get());
            assertThat(statuses).containsExactlyInAnyOrder(200, 409);
        } finally {
            pool.shutdownNow();
        }

        String driver = read(getAs(asha, "/api/v1/sessions/{id}", session), "$.session.driverName");
        assertThat(driver).isIn("Ben", "Cara");
        // One start for Asha's prompt and exactly one for the winning takeover, carrying the task over.
        ArgumentCaptor<StartTurn> started = ArgumentCaptor.forClass(StartTurn.class);
        verify(agentRunner, times(2)).start(started.capture());
        StartTurn takeover = started.getAllValues().get(1);
        assertThat(takeover.sponsor().name()).isEqualTo(driver);
        assertThat(takeover.prompt()).contains("taking over this session from Asha").contains("Task: Refactor auth");
        verify(agentRunner).cancel(any());
    }

    @Test
    void aStalledDriverPutsTheSessionAwaitingTakeover() throws Exception {
        String session = session("Long job");
        String turn = prompt(asha, session, "go");
        internal(post("/internal/agent/turns/{t}/finish", turn), "{'status':'BUDGET_EXCEEDED','error':'cap'}");
        getAs(asha, "/api/v1/sessions/{id}", session).andExpect(jsonPath("$.session.status").value("AWAITING_TAKEOVER"));

        // Prompting again as the driver resumes it; losing edit rights stalls it again.
        prompt(asha, session, "continue");
        getAs(asha, "/api/v1/sessions/{id}", session).andExpect(jsonPath("$.session.status").value("ACTIVE"));

        Member ben = member("Ben", "EDITOR");
        perform(asha, post("/api/v1/sessions/" + session + "/handoff"), "{'toUserId':'%s','rowVersion':%d}", ben.id(),
                rowVersion(asha, session)).andExpect(status().isOk()).andExpect(jsonPath("$.driverName").value("Ben"));
        perform(asha, patch("/api/v1/workspaces/" + workspace + "/members/" + ben.id()), "{'role':'VIEWER'}")
                .andExpect(status().isOk());
        getAs(asha, "/api/v1/sessions/{id}", session).andExpect(jsonPath("$.session.status").value("AWAITING_TAKEOVER"));
    }

    @Test
    void planStepsBelongToPeopleIncludingCommenters() throws Exception {
        String session = session("Ship docs");
        Member cleo = member("Cleo", "COMMENTER");
        Member ben = member("Ben", "EDITOR");
        perform(asha, post("/api/v1/sessions/" + session + "/steps"), "{'titles':['Outline','Write guide']}")
                .andExpect(jsonPath("$.length()").value(2));
        perform(cleo.session(), post("/api/v1/sessions/" + session + "/steps"), "{'titles':['nope']}")
                .andExpect(status().isForbidden());
        String step = read(getAs(asha, "/api/v1/sessions/{id}", session), "$.plan[0].id");

        perform(cleo.session(), post("/api/v1/steps/" + step + "/take"), "{'rowVersion':0}")
                .andExpect(status().isOk()).andExpect(jsonPath("$.ownerName").value("Cleo"));
        perform(ben.session(), post("/api/v1/steps/" + step + "/take"), "{'rowVersion':1}")
                .andExpect(status().isConflict());
        perform(ben.session(), patch("/api/v1/steps/" + step), "{'status':'DONE','release':false,'rowVersion':1}")
                .andExpect(status().isForbidden());
        perform(cleo.session(), patch("/api/v1/steps/" + step), "{'status':'DONE','release':false,'rowVersion':1}")
                .andExpect(jsonPath("$.status").value("DONE"));
        getAs(asha, "/api/v1/workspaces/{w}/sessions", workspace)
                .andExpect(jsonPath("$[0].stepsDone").value(1))
                .andExpect(jsonPath("$[0].stepsTotal").value(2));
    }

    @Test
    void agentsProposeStepsOwnedByTheirSponsorAndOnlyMoveThose() throws Exception {
        String session = session("Validation");
        perform(asha, post("/api/v1/sessions/" + session + "/steps"), "{'titles':['Human step']}");
        String turn = prompt(asha, session, "plan it");
        internal(post("/internal/agent/turns/{t}/plan", turn), "{'steps':['Read handler','Add checks']}")
                .andExpect(jsonPath("$.length()").value(3))
                .andExpect(jsonPath("$[1].ownerName").value("Asha"));
        internal(post("/internal/agent/turns/{t}/plan/status", turn), "{'position':2,'status':'IN_PROGRESS'}")
                .andExpect(jsonPath("$[1].status").value("IN_PROGRESS"));
        internal(post("/internal/agent/turns/{t}/plan/status", turn), "{'position':1,'status':'DONE'}")
                .andExpect(status().isForbidden());
    }

    @Test
    void onlyTheSponsorSteersAndLateGuidanceIsRefused() throws Exception {
        String session = session("Steer me");
        String turn = prompt(asha, session, "go");
        Member ben = member("Ben", "EDITOR");
        when(agentRunner.steer(any(), anyString())).thenReturn(true);
        perform(ben.session(), post("/api/v1/workspaces/" + workspace + "/agent/turns/" + turn + "/steer"), "{'text':'stop'}")
                .andExpect(status().isForbidden());
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns/" + turn + "/steer"), "{'text':'focus on email'}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.events[1].kind").value("steer"));
        internal(post("/internal/agent/turns/{t}/finish", turn), "{'status':'SUCCEEDED'}");
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns/" + turn + "/steer"), "{'text':'too late'}")
                .andExpect(status().isConflict());
    }

    @Test
    void commentsAnchorToCodeBecomeStepsAndResolveWithoutDeleting() throws Exception {
        String session = session("Review");
        Member cleo = member("Cleo", "COMMENTER");
        Member vic = member("Vic", "VIEWER");
        String body = "{'targetKind':'FILE_RANGE','sessionId':'%s','fileId':'%s','anchor':{'start':{'type':null,'item':{'client':1,'clock':0}},'end':{'item':{'client':1,'clock':4}}},'quote':'save(user)','body':'Validate before saving'}";
        perform(vic.session(), post("/api/v1/workspaces/" + workspace + "/comments"), body, session, file)
                .andExpect(status().isForbidden());
        String comment = id(perform(cleo.session(), post("/api/v1/workspaces/" + workspace + "/comments"), body, session, file)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.anchor.end.item.clock").value(4)));

        perform(cleo.session(), post("/api/v1/workspaces/" + workspace + "/comments/" + comment + "/to-step"), "{}")
                .andExpect(status().isForbidden());
        perform(asha, post("/api/v1/workspaces/" + workspace + "/comments/" + comment + "/to-step"), "{}")
                .andExpect(jsonPath("$.causedStepId").isNotEmpty());
        getAs(asha, "/api/v1/sessions/{id}", session).andExpect(jsonPath("$.plan[0].title").value("Validate before saving"));

        perform(cleo.session(), post("/api/v1/workspaces/" + workspace + "/comments/" + comment + "/resolve"), "{'resolved':true}")
                .andExpect(jsonPath("$.status").value("RESOLVED"));
        getAs(vic.session(), "/api/v1/workspaces/{w}/comments?fileId={f}", workspace, file)
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].authorName").value("Cleo"));
    }

    @Test
    void onlyTheDriverOrAnOwnerFinishesASession() throws Exception {
        String session = session("Wrap up");
        Member ben = member("Ben", "EDITOR");
        perform(ben.session(), post("/api/v1/sessions/" + session + "/finish"), "{'rowVersion':%d}", rowVersion(asha, session))
                .andExpect(status().isConflict());
        perform(asha, post("/api/v1/sessions/" + session + "/finish"), "{'rowVersion':%d}", rowVersion(asha, session))
                .andExpect(jsonPath("$.status").value("DONE"));
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'more','sessionId':'%s'}", session)
                .andExpect(status().isConflict());
        mvc.perform(delete("/api/v1/steps/{id}", UUID.randomUUID()).session(asha).with(csrf())).andExpect(status().isNotFound());
    }
}
