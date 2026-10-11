package dev.converge.api.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.startsWith;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;

import dev.converge.api.IntegrationTest;

/** Versions, checkpoints and restores (FR-10, design §9). */
class HistoryApiTest extends IntegrationTest {

    private MockHttpSession asha;
    private String workspace;
    private String file;

    @BeforeEach
    void setUp() throws Exception {
        asha = signUp("Asha");
        workspace = createWorkspace(asha, "History");
        file = id(createFile(asha, workspace, null, "story.md", "FILE"));
        write("once upon a time");
    }

    @Test
    void checkpointsAreNumberedAndUnchangedTextIsNotDuplicated() throws Exception {
        var first = checkpoint("first draft").andExpect(status().isCreated());
        int versionNo = read(first, "$.versionNo");
        assertThat(read(first, "$.label").toString()).isEqualTo("first draft");

        checkpoint("same text again").andExpect(jsonPath("$.versionNo").value(versionNo));
        write("once upon a time, again");
        checkpoint("second draft").andExpect(jsonPath("$.versionNo").value(versionNo + 1));
    }

    @Test
    void externalChangesAreVersionedFirstSoTheyCanBeUndone() throws Exception {
        write("the original");
        write("an API overwrite");

        List<String> reasons = read(getAs(asha, "/api/v1/files/{id}/history", file), "$[*].reason");
        assertThat(reasons).contains("PRE_EXTERNAL");
        String newestPreExternal = read(getAs(asha, "/api/v1/files/{id}/history", file), "$[0].id");
        getAs(asha, "/api/v1/files/{f}/snapshots/{s}", file, newestPreExternal)
                .andExpect(jsonPath("$.text").value("the original"));
    }

    @Test
    void restoreMergesTheOldTextThroughTheCollaborationService() throws Exception {
        String v1 = read(checkpoint("before the rewrite"), "$.id");
        write("a complete rewrite");

        perform(asha, post("/api/v1/files/" + file + "/restore"), "{'snapshotId':'%s'}", v1).andExpect(status().isOk());

        verify(collab).applyText(eq(UUID.fromString(file)), eq("once upon a time"), startsWith("restore:"));
        String preRestore = read(getAs(asha, "/api/v1/files/{id}/history", file), "$[0].id");
        getAs(asha, "/api/v1/files/{f}/snapshots/{s}", file, preRestore)
                .andExpect(jsonPath("$.text").value("a complete rewrite"));
        List<String> actions = read(getAs(asha, "/api/v1/workspaces/{id}/audit", workspace), "$[*].action");
        assertThat(actions).contains("file.restored");
    }

    @Test
    void viewersCanBrowseHistoryButNotChangeIt() throws Exception {
        String v1 = read(checkpoint("v1"), "$.id");
        String email = "viewer-" + UUID.randomUUID() + "@example.test";
        var viewer = signUpAs(email);
        perform(asha, post("/api/v1/workspaces/" + workspace + "/members"), "{'email':'%s','role':'VIEWER'}", email);

        getAs(viewer, "/api/v1/files/{id}/history", file).andExpect(status().isOk());
        getAs(viewer, "/api/v1/files/{f}/snapshots/{s}", file, v1).andExpect(status().isOk());
        perform(viewer, post("/api/v1/files/" + file + "/snapshots"), "{'label':'mine'}").andExpect(status().isForbidden());
        perform(viewer, post("/api/v1/files/" + file + "/restore"), "{'snapshotId':'%s'}", v1).andExpect(status().isForbidden());
    }

    @Test
    void outsidersCannotSeeHistory() throws Exception {
        var mallory = signUp("Mallory");
        getAs(mallory, "/api/v1/files/{id}/history", file).andExpect(status().isNotFound());
    }

    @Test
    void deletingAFolderClosesTheLiveDocumentsOfEveryFileInIt() throws Exception {
        String folder = id(createFile(asha, workspace, null, "chapters", "FOLDER"));
        String nested = id(createFile(asha, workspace, folder, "one.md", "FILE"));

        mvc.perform(delete("/api/v1/files/{id}", folder).param("rowVersion", "0").session(asha).with(csrf()))
                .andExpect(status().isNoContent());

        verify(collab, timeout(2000)).close(UUID.fromString(nested));
    }

    private void write(String text) throws Exception {
        perform(asha, put("/api/v1/files/" + file + "/content"), "{'text':'%s'}", text).andExpect(status().isOk());
    }

    private org.springframework.test.web.servlet.ResultActions checkpoint(String label) throws Exception {
        return perform(asha, post("/api/v1/files/" + file + "/snapshots"), "{'label':'%s'}", label);
    }

    private MockHttpSession signUpAs(String email) throws Exception {
        var result = mvc.perform(post("/api/v1/auth/register").with(csrf())
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content(json("{'email':'%s','displayName':'Viewer','password':'correct horse battery'}", email)))
                .andExpect(status().isCreated())
                .andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }
}
