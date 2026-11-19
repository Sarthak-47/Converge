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
                .andExpect(jsonPath("$[0].events[2].text").value("Done. My key is sk-ant-…redacted"));

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
    void theInternalApiNeedsTheServiceToken() throws Exception {
        mvc.perform(get("/internal/agent/turns/{t}/tree", UUID.randomUUID())).andExpect(status().isUnauthorized());
        verify(agentRunner, never()).revert(any(), anyString(), anyList());
    }
}
