package dev.converge.api.memory;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.verify;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import dev.converge.api.realtime.WorkspaceEvent;

import dev.converge.api.IntegrationTest;
import dev.converge.api.agent.AgentRunnerClient.StartTurn;
import dev.converge.api.realtime.InternalTokenFilter;

/** Phase 11 (design §13.10, §13.11): workspace memory, staleness, overlaps and held ranges. */
class MemoryApiTest extends IntegrationTest {

    private static final String ANCHOR = "{'start':{'type':null,'tname':null,'item':{'client':1,'clock':0},'assoc':0},'end':{'type':null,'tname':null,'item':{'client':1,'clock':20},'assoc':-1}}";

    /** Watches what reaches subscribers, to prove events raised outside a transaction are delivered. */
    @MockitoSpyBean
    private SimpMessagingTemplate messaging;

    private MockHttpSession asha;
    private String workspace;
    private String file;

    @BeforeEach
    void setUp() throws Exception {
        asha = signUp("Asha");
        workspace = createWorkspace(asha, "Memory");
        file = id(createFile(asha, workspace, null, "retry.ts", "FILE"));
        perform(asha, put("/api/v1/me/provider-keys/anthropic"), "{'apiKey':'sk-ant-test-0123456789abcdef'}");
    }

    private ResultActions internal(MockHttpServletRequestBuilder request, String body, Object... args) throws Exception {
        if (body != null) request.contentType(MediaType.APPLICATION_JSON).content(json(body, args));
        return mvc.perform(request.header(InternalTokenFilter.HEADER, INTERNAL_TOKEN));
    }

    private String note(MockHttpSession who, String body) throws Exception {
        return id(perform(who, post("/api/v1/workspaces/" + workspace + "/memories"),
                "{'fileId':'%s','kind':'GOTCHA','body':'%s','anchor':" + ANCHOR + ",'anchoredText':'export const retry = 3'}", file, body)
                .andExpect(status().isCreated()));
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
    void notesArePinnedAndTheCollaborationServiceFlagsThemStale() throws Exception {
        MockHttpSession cleo = member("COMMENTER");
        MockHttpSession vic = member("VIEWER");
        String id = note(cleo, "Upstream allows three calls");
        perform(vic, post("/api/v1/workspaces/" + workspace + "/memories"),
                "{'fileId':'%s','kind':'NOTE','body':'x','anchor':" + ANCHOR + ",'anchoredText':'y'}", file)
                .andExpect(status().isForbidden());

        org.mockito.Mockito.clearInvocations(messaging);
        internal(post("/internal/memories/checked"), "{'checks':[{'id':'%s','currentText':'return fetchAll()','similarity':0.2,'status':'STALE'}]}", id)
                .andExpect(status().isNoContent());
        // Reported outside any transaction, yet it must reach the workspace (it used to be dropped).
        ArgumentCaptor<Object> sent = ArgumentCaptor.forClass(Object.class);
        verify(messaging, atLeastOnce()).convertAndSend(org.mockito.ArgumentMatchers.eq("/topic/workspace/" + workspace + "/events"), sent.capture());
        assertThat(sent.getAllValues()).anySatisfy(e -> assertThat(((WorkspaceEvent) e).type()).isEqualTo("MEMORY_CHANGED"));
        getAs(vic, "/api/v1/workspaces/{w}/memories?fileId={f}", workspace, file)
                .andExpect(jsonPath("$[0].status").value("STALE"))
                .andExpect(jsonPath("$[0].currentText").value("return fetchAll()"))
                .andExpect(jsonPath("$[0].path").value("retry.ts"))
                .andExpect(jsonPath("$[0].authorName").value("COMMENTER"));

        // Rewriting it with a new anchor makes it current again; retiring hides it from the default list.
        int version = read(getAs(asha, "/api/v1/workspaces/{w}/memories", workspace), "$[0].rowVersion");
        perform(asha, patch("/api/v1/memories/" + id), "{'body':'Now fetches all pages','anchor':" + ANCHOR + ",'anchoredText':'return fetchAll()','rowVersion':%d}", version)
                .andExpect(jsonPath("$.status").value("ACTIVE"))
                .andExpect(jsonPath("$.anchoredText").value("return fetchAll()"));
        perform(asha, patch("/api/v1/memories/" + id), "{'body':'stale write','rowVersion':%d}", version)
                .andExpect(status().isConflict());
        perform(cleo, patch("/api/v1/memories/" + id), "{'retire':true}").andExpect(jsonPath("$.status").value("RETIRED"));
        getAs(asha, "/api/v1/workspaces/{w}/memories", workspace).andExpect(jsonPath("$.length()").value(0));
        getAs(asha, "/api/v1/workspaces/{w}/memories?includeRetired=true", workspace).andExpect(jsonPath("$.length()").value(1));
    }

    @Test
    void agentsGetRelevantNotesOverlapsAndHeldRangesWhenATurnStarts() throws Exception {
        note(asha, "Upstream allows three calls");
        String mine = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/sessions"), "{'task':'Tune retries'}"));
        String theirs = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/sessions"), "{'task':'Rewrite the client'}"));
        perform(asha, post("/api/v1/workspaces/" + workspace + "/locks"),
                "{'fileId':'%s','anchor':" + ANCHOR + ",'quote':'export const retry = 3','reason':'benchmarking'}", file)
                .andExpect(status().isCreated());

        // The other session's agent opens retry.ts; then this session's agent does too.
        String other = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'x','sessionId':'%s'}", theirs));
        internal(post("/internal/agent/turns/{t}/tickets", other), "{'fileId':'%s'}", file).andExpect(status().isOk());
        String turn = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'y','sessionId':'%s'}", mine));
        internal(post("/internal/agent/turns/{t}/tickets", turn), "{'fileId':'%s'}", file).andExpect(status().isOk());
        getAs(asha, "/api/v1/sessions/{s}/overlaps", mine)
                .andExpect(jsonPath("$[0].task").value("Rewrite the client"))
                .andExpect(jsonPath("$[0].files[0]").value("retry.ts"));

        internal(post("/internal/agent/turns/{t}/finish", turn), "{'status':'SUCCEEDED'}");
        perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'again','sessionId':'%s'}", mine)
                .andExpect(status().isCreated());
        ArgumentCaptor<StartTurn> started = ArgumentCaptor.forClass(StartTurn.class);
        verify(agentRunner, atLeastOnce()).start(started.capture());
        String context = started.getValue().context();
        assertThat(context).contains("retry.ts (gotcha, active): Upstream allows three calls")
                .contains("\"Rewrite the client\" (driven by Asha): retry.ts")
                .contains("retry.ts: held by Asha (benchmarking)");
    }

    @Test
    void theRunnerReadsAndWritesNotesAsTheSponsor() throws Exception {
        String session = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/sessions"), "{'task':'t'}"));
        String turn = id(perform(asha, post("/api/v1/workspaces/" + workspace + "/agent/turns"), "{'prompt':'x','sessionId':'%s'}", session));
        String id = id(internal(post("/internal/agent/turns/{t}/memory", turn),
                "{'fileId':'%s','kind':'DECISION','body':'Keep it at three','anchor':" + ANCHOR + ",'anchoredText':'export const retry = 3'}", file)
                .andExpect(status().isOk()));
        internal(get("/internal/agent/turns/{t}/memory?fileId={f}", turn, file), null)
                .andExpect(jsonPath("$[0].id").value(id))
                .andExpect(jsonPath("$[0].createdInTurn").value(turn));
        internal(post("/internal/agent/turns/{t}/memory/{m}", turn, id), "{'retire':true}")
                .andExpect(jsonPath("$.status").value("RETIRED"));
    }

    @Test
    void onlyTheHolderOrAnOwnerReleasesALock() throws Exception {
        MockHttpSession ben = member("EDITOR");
        String lock = id(perform(ben, post("/api/v1/workspaces/" + workspace + "/locks"),
                "{'fileId':'%s','anchor':" + ANCHOR + ",'quote':'x','reason':'mine for now','minutes':30}", file)
                .andExpect(jsonPath("$.holderName").value("EDITOR")));
        MockHttpSession cara = member("EDITOR");
        mvc.perform(delete("/api/v1/locks/{id}", lock).session(cara).with(csrf())).andExpect(status().isForbidden());
        mvc.perform(delete("/api/v1/locks/{id}", lock).session(asha).with(csrf())).andExpect(status().isNoContent());
        getAs(ben, "/api/v1/workspaces/{w}/locks", workspace).andExpect(jsonPath("$.length()").value(0));
        MockHttpSession cleo = member("COMMENTER");
        perform(cleo, post("/api/v1/workspaces/" + workspace + "/locks"),
                "{'fileId':'%s','anchor':" + ANCHOR + ",'quote':'x','reason':'r'}", file).andExpect(status().isForbidden());
    }
}
