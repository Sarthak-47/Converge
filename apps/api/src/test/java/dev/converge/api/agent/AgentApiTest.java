package dev.converge.api.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import dev.converge.api.IntegrationTest;
import dev.converge.api.agent.AgentRunnerClient.RevertFile;
import dev.converge.api.agent.AgentRunnerClient.StartTurn;
import dev.converge.api.realtime.InternalTokenFilter;

/** Phase 8 (design §13): own keys, sponsored turns, the runner's internal API, the cost ledger and revert. */
class AgentApiTest extends IntegrationTest {

    private static final String KEY = "sk-ant-test-0123456789abcdefWXYZ";

    private MockHttpSession asha;
    private String workspace;
    private String file;

    @BeforeEach
    void setUp() throws Exception {
        asha = signUp("Asha");
        workspace = createWorkspace(asha, "Agents");
        file = id(createFile(asha, workspace, null, "signup.ts", "FILE"));
    }

    private ResultActions setKey(MockHttpSession session, String key) throws Exception {
        return perform(session, put("/api/v1/me/provider-keys/anthropic"), "{'apiKey':'%s'}", key);
    }

    private ResultActions prompt(MockHttpSession session, String text) throws Exception {
        return perform(session, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'%s'}", text);
    }

    private ResultActions internal(MockHttpServletRequestBuilder request, String body, Object... args) throws Exception {
        if (body != null) request.contentType(MediaType.APPLICATION_JSON).content(json(body, args));
        return mvc.perform(request.header(InternalTokenFilter.HEADER, INTERNAL_TOKEN));
    }

    private MockHttpSession member(String role) throws Exception {
        String email = role.toLowerCase() + "-" + UUID.randomUUID() + "@example.test";
        var result = mvc.perform(post("/api/v1/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'%s','displayName':'%s','password':'correct horse battery'}", email, role)))
                .andExpect(status().isCreated()).andReturn();
        perform(asha, post("/api/v1/workspaces/" + workspace + "/members"), "{'email':'%s','role':'%s'}", email, role)
                .andExpect(status().is2xxSuccessful());
        return (MockHttpSession) result.getRequest().getSession(false);
    }

    @Test
    void keysAreStoredEncryptedAndOnlyAHintIsShown() throws Exception {
        getAs(asha, "/api/v1/me/provider-keys/anthropic").andExpect(jsonPath("$.configured").value(false));
        setKey(asha, KEY).andExpect(status().isOk()).andExpect(jsonPath("$.hint").value("…WXYZ"));
        String body = getAs(asha, "/api/v1/me/provider-keys/anthropic").andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain(KEY).contains("…WXYZ");

        byte[] stored = jdbc.sql("select ciphertext from provider_keys p join users u on u.id = p.user_id where u.display_name = 'Asha' order by p.created_at desc limit 1")
                .query(byte[].class).single();
        assertThat(new String(stored, StandardCharsets.ISO_8859_1)).doesNotContain("sk-ant");
        setKey(asha, "not-a-real-key-at-all-123").andExpect(status().isBadRequest());
    }

    @Test
    void aTurnNeedsTheMembersOwnKeyAndEditRights() throws Exception {
        prompt(asha, "hello").andExpect(status().isConflict());
        MockHttpSession viewer = member("VIEWER");
        setKey(viewer, KEY);
        prompt(viewer, "hello").andExpect(status().isForbidden());
        verify(agentRunner, never()).start(any());
    }

    @Test
    void aMemberPicksTheModelForATurnFromTheAllowedOnes() throws Exception {
        setKey(asha, KEY);
        getAs(asha, "/api/v1/workspaces/{w}/agent/turns/models", workspace)
                .andExpect(jsonPath("$[0]").value("claude-opus-5-5"))
                .andExpect(jsonPath("$.length()").value(3));
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'quick fix','model':'gpt-5'}")
                .andExpect(status().isBadRequest());
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'quick fix','model':'claude-haiku-5-5'}")
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.model").value("claude-haiku-5-5"));
        ArgumentCaptor<StartTurn> started = ArgumentCaptor.forClass(StartTurn.class);
        verify(agentRunner).start(started.capture());
        assertThat(started.getValue().model()).isEqualTo("claude-haiku-5-5");
    }

    @Test
    void aMemberCanBringAKeyForAnotherProviderAndRunTurnsOnIt() throws Exception {
        String openAi = "sk-proj-test-0123456789abcdOPEN";
        perform(asha, put("/api/v1/me/provider-keys/openai"), "{'apiKey':'%s'}", KEY).andExpect(status().isBadRequest());
        perform(asha, put("/api/v1/me/provider-keys/gemini"), "{'apiKey':'%s'}", "AIzaSyTest0123456789abcdefGEMI").andExpect(status().isOk());
        perform(asha, put("/api/v1/me/provider-keys/openai"), "{'apiKey':'%s'}", openAi)
                .andExpect(status().isOk()).andExpect(jsonPath("$.hint").value("…OPEN"));
        perform(asha, put("/api/v1/me/provider-keys/mistral"), "{'apiKey':'%s'}", openAi).andExpect(status().isNotFound());
        getAs(asha, "/api/v1/me/provider-keys")
                .andExpect(jsonPath("$[?(@.provider == 'anthropic')].configured").value(false))
                .andExpect(jsonPath("$[?(@.provider == 'openai')].hint").value("…OPEN"))
                .andExpect(jsonPath("$[?(@.provider == 'gemini')].configured").value(true));
        getAs(asha, "/api/v1/workspaces/{w}/agent/turns/model-options", workspace)
                .andExpect(jsonPath("$.customModels").value(true));

        // No Anthropic key, so a Claude model is refused; a model on OpenAI runs on the OpenAI key.
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'hi','model':'claude-opus-5-5'}")
                .andExpect(status().isConflict());
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'hi','model':'openai:gpt-test'}")
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.model").value("openai:gpt-test"));
        ArgumentCaptor<StartTurn> started = ArgumentCaptor.forClass(StartTurn.class);
        verify(agentRunner).start(started.capture());
        assertThat(started.getValue().provider()).isEqualTo("openai");
        assertThat(started.getValue().model()).isEqualTo("gpt-test");
        assertThat(started.getValue().apiKey()).isEqualTo(openAi);

        // Without a model named (a comment sent to the agent, say), it reuses the last one it can pay for.
        String turn = jdbc.sql("select id from agent_turns where model = 'openai:gpt-test'").query(String.class).single();
        internal(post("/internal/agent/turns/{t}/finish", turn), "{'status':'SUCCEEDED','error':null}").andExpect(status().isNoContent());
        prompt(asha, "again").andExpect(status().isCreated()).andExpect(jsonPath("$.model").value("openai:gpt-test"));

        mvc.perform(delete("/api/v1/me/provider-keys/openai").session(asha).with(csrf())).andExpect(status().isNoContent());
        getAs(asha, "/api/v1/me/provider-keys/openai").andExpect(jsonPath("$.configured").value(false));
    }

    @Test
    void aTurnRunsOnTheSponsorsKeyAndRecordsItsTranscriptAndCost() throws Exception {
        setKey(asha, KEY);
        String turn = id(prompt(asha, "add validation").andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("RUNNING"))
                .andExpect(jsonPath("$.sponsorName").value("Asha")));

        ArgumentCaptor<StartTurn> started = ArgumentCaptor.forClass(StartTurn.class);
        verify(agentRunner).start(started.capture());
        assertThat(started.getValue().apiKey()).isEqualTo(KEY);
        assertThat(started.getValue().model()).isEqualTo("claude-opus-5-5");
        assertThat(started.getValue().effort()).isEqualTo("high");
        assertThat(started.getValue().sponsor().name()).isEqualTo("Asha");
        prompt(asha, "a second one at once").andExpect(status().isConflict());

        // The runner's side: tree, ticket, events, usage, revert state, finish.
        internal(get("/internal/agent/turns/{t}/tree", turn), null)
                .andExpect(jsonPath("$[0].path").value("signup.ts"));
        internal(post("/internal/agent/turns/{t}/tickets", turn), "{'fileId':'%s'}", file)
                .andExpect(jsonPath("$.ticket").isNotEmpty());
        internal(post("/internal/agent/turns/{t}/events", turn), "{'kind':'tool','name':'edit_file','summary':'edited signup.ts','ok':true}")
                .andExpect(status().isNoContent());
        internal(post("/internal/agent/turns/{t}/events", turn), "{'kind':'text','text':'Done. My key is %s'}", KEY)
                .andExpect(status().isNoContent());
        internal(post("/internal/agent/turns/{t}/usage", turn),
                "{'inputTokens':1000,'outputTokens':200,'cacheReadTokens':0,'cacheWriteTokens':0,'costMicros':8000,'model':'claude-opus-5-5'}")
                .andExpect(jsonPath("$.costMicros").value(8000));
        internal(put("/internal/agent/turns/{t}/files/{f}/revert-state", turn, file),
                "{'state':'AAEC','undo':{'insertions':{'7':[[0,5]]},'deletions':{}}}")
                .andExpect(status().isNoContent());
        internal(post("/internal/agent/turns/{t}/finish", turn), "{'status':'SUCCEEDED','error':null}")
                .andExpect(status().isNoContent());
        internal(post("/internal/agent/turns/{t}/events", turn), "{'kind':'text','text':'late'}")
                .andExpect(status().isConflict());

        MockHttpSession viewer = member("VIEWER");
        getAs(viewer, "/api/v1/workspaces/{w}/agent/turns", workspace)
                .andExpect(jsonPath("$[0].status").value("SUCCEEDED"))
                .andExpect(jsonPath("$[0].costMicros").value(8000))
                .andExpect(jsonPath("$[0].revertible").value(true))
                .andExpect(jsonPath("$[0].events[0].kind").value("prompt"))
                .andExpect(jsonPath("$[0].events[0].text").value("add validation"))
                .andExpect(jsonPath("$[0].events[1].summary").value("edited signup.ts"))
                .andExpect(jsonPath("$[0].events[2].text").value("Done. My key is …redacted key…"));

        // The next turn in the lane carries this exchange as history.
        prompt(asha, "and now tests").andExpect(status().isCreated());
        verify(agentRunner, org.mockito.Mockito.times(2)).start(started.capture());
        assertThat(started.getValue().history()).hasSize(1);
        assertThat(started.getValue().history().getFirst().prompt()).isEqualTo("add validation");
    }

    @Test
    void anyEditorCanRevertAFinishedTurnOnce() throws Exception {
        setKey(asha, KEY);
        String turn = id(prompt(asha, "edit"));
        internal(put("/internal/agent/turns/{t}/files/{f}/revert-state", turn, file),
                "{'state':'AAEC','undo':{'insertions':{'7':[[0,5]]},'deletions':{}}}");
        MockHttpSession ben = member("EDITOR");
        perform(ben, post("/api/v1/workspaces/" + workspace + "/agent/turns/" + turn + "/revert"), "{}")
                .andExpect(status().isConflict()); // still running
        internal(post("/internal/agent/turns/{t}/finish", turn), "{'status':'SUCCEEDED'}");

        perform(ben, post("/api/v1/workspaces/" + workspace + "/agent/turns/" + turn + "/revert"), "{}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.revertStatus").value("REVERTED"))
                .andExpect(jsonPath("$.revertible").value(false));
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<RevertFile>> files = ArgumentCaptor.forClass(List.class);
        verify(agentRunner).revert(eq(UUID.fromString(turn)), eq("EDITOR"), files.capture());
        assertThat(files.getValue()).singleElement().satisfies(f -> {
            assertThat(f.fileId().toString()).isEqualTo(file);
            assertThat(f.state()).isEqualTo("AAEC");
        });
        perform(ben, post("/api/v1/workspaces/" + workspace + "/agent/turns/" + turn + "/revert"), "{}")
                .andExpect(status().isConflict());
    }

    @Test
    void onlyTheSponsorStopsATurn() throws Exception {
        setKey(asha, KEY);
        String turn = id(prompt(asha, "long task"));
        MockHttpSession ben = member("EDITOR");
        perform(ben, post("/api/v1/workspaces/" + workspace + "/agent/turns/" + turn + "/cancel"), "{}")
                .andExpect(status().isForbidden());
        when(agentRunner.cancel(UUID.fromString(turn))).thenReturn(false); // e.g. the runner restarted
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns/" + turn + "/cancel"), "{}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELLED"));
    }

    @Test
    void aSponsorWhoLosesAccessStopsTheirAgent() throws Exception {
        MockHttpSession ben = member("EDITOR");
        setKey(ben, KEY);
        String turn = id(prompt(ben, "work"));
        String benId = jdbc.sql("select sponsor_id::text from agent_turns where id = ?::uuid").param(turn).query(String.class).single();
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .delete("/api/v1/workspaces/{w}/members/{u}", workspace, benId).session(asha).with(csrf()))
                .andExpect(status().is2xxSuccessful());
        internal(get("/internal/agent/turns/{t}/tree", turn), null).andExpect(status().isForbidden());
        internal(post("/internal/agent/turns/{t}/tickets", turn), "{'fileId':'%s'}", file).andExpect(status().isForbidden());
    }

    @Test
    void turnsWhoseRunnerDiedAreEndedOnceTheirLeaseLapses(@org.springframework.beans.factory.annotation.Autowired RunnerLeaseSweep sweep)
            throws Exception {
        // One running turn per lane, so each turn below is in its own member's lane.
        member("EDITOR");
        member("COMMENTER");
        List<String> people = jdbc.sql("select user_id::text from workspace_members where workspace_id = ?::uuid order by role")
                .param(workspace).query(String.class).list();
        UUID orphaned = UUID.randomUUID();
        UUID alive = UUID.randomUUID();
        UUID fresh = UUID.randomUUID();
        String[] ages = {"5 minutes", "5 minutes", "10 seconds"};
        UUID[] ids = {orphaned, alive, fresh};
        for (int i = 0; i < ids.length; i++) {
            jdbc.sql("""
                    insert into agent_turns (id, workspace_id, lane_user_id, sponsor_id, model, status, cost_cap_micros, started_at)
                    values (?, ?::uuid, ?::uuid, ?::uuid, 'claude-opus-5-5', 'RUNNING', 2000000, now() - cast(? as interval))
                    """).params(ids[i], workspace, people.get(i), people.get(i), ages[i]).update();
        }
        // Only the old turn without a lease ends; a turn just started may not have one yet.
        assertThat(sweep.sweep(id -> id.equals(alive))).isEqualTo(1);
        assertThat(turnStatus(orphaned)).isEqualTo("FAILED");
        assertThat(turnStatus(alive)).isEqualTo("RUNNING");
        assertThat(turnStatus(fresh)).isEqualTo("RUNNING");
    }

    private String turnStatus(UUID turnId) {
        return jdbc.sql("select status from agent_turns where id = ?").param(turnId).query(String.class).single();
    }

    @Test
    void theInternalApiNeedsTheServiceToken() throws Exception {
        mvc.perform(get("/internal/agent/turns/{t}/tree", UUID.randomUUID())).andExpect(status().isUnauthorized());
        verify(agentRunner, never()).revert(any(), anyString(), anyList());
    }

    @Test
    void theDailyCapLimitsEachTurnAndThenRefusesNewOnes() throws Exception {
        setKey(asha, KEY);
        String ashaId = jdbc.sql("select id::text from users where display_name = 'Asha' order by created_at desc limit 1").query(String.class).single();
        // Earlier turns today already spent $19 of the $20 daily cap.
        jdbc.sql("""
                insert into agent_turns (id, workspace_id, lane_user_id, sponsor_id, model, status, cost_micros, cost_cap_micros, ended_at)
                values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, 'claude-opus-5-5', 'SUCCEEDED', 19000000, 2000000, now())
                """).params(workspace, ashaId, ashaId).update();
        getAs(asha, "/api/v1/me/agent-spend").andExpect(jsonPath("$.spentMicros").value(19000000))
                .andExpect(jsonPath("$.dailyCapMicros").value(20000000));

        String turn = id(prompt(asha, "one more"));
        ArgumentCaptor<StartTurn> started = ArgumentCaptor.forClass(StartTurn.class);
        verify(agentRunner).start(started.capture());
        assertThat(started.getValue().costCapMicros()).isEqualTo(1000000); // what is left today, below the $2 turn cap

        internal(post("/internal/agent/turns/{t}/usage", turn),
                "{'inputTokens':1,'outputTokens':1,'cacheReadTokens':0,'cacheWriteTokens':0,'costMicros':1000000,'model':'claude-opus-5-5'}");
        internal(post("/internal/agent/turns/{t}/finish", turn), "{'status':'BUDGET_EXCEEDED','error':'cap'}");
        prompt(asha, "and another").andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("daily cap")));
    }
}
