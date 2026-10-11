package dev.converge.api.workspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;

import dev.converge.api.IntegrationTest;

/** Members, roles and invitations (FR-03), and the Phase 5 exit criterion: viewers cannot mutate anything. */
class MemberApiTest extends IntegrationTest {

    private MockHttpSession owner;
    private String workspace;

    @BeforeEach
    void setUp() throws Exception {
        owner = signUp("Owner");
        workspace = createWorkspace(owner, "Team");
    }

    @Test
    void ownerAddsAnExistingUserWhoThenSeesTheWorkspace() throws Exception {
        String email = "editor-" + UUID.randomUUID() + "@example.test";
        var editor = signUpWithEmail("Editor", email);

        add(email, "EDITOR").andExpect(status().isCreated()).andExpect(jsonPath("$.member.role").value("EDITOR"));

        getAs(editor, "/api/v1/workspaces/{id}", workspace).andExpect(jsonPath("$.role").value("EDITOR"));
        List<String> names = read(getAs(owner, "/api/v1/workspaces/{id}/members", workspace), "$.members[*].displayName");
        assertThat(names).containsExactly("Owner", "Editor");
    }

    @Test
    void invitationsBecomeMembershipsWhenThePersonSignsUp() throws Exception {
        String email = "later-" + UUID.randomUUID() + "@example.test";
        add(email, "COMMENTER").andExpect(status().isAccepted()).andExpect(jsonPath("$.invitation.email").value(email));

        var newcomer = signUpWithEmail("Newcomer", email);

        getAs(newcomer, "/api/v1/workspaces/{id}", workspace).andExpect(jsonPath("$.role").value("COMMENTER"));
        getAs(owner, "/api/v1/workspaces/{id}/members", workspace).andExpect(jsonPath("$.invitations.length()").value(0));
    }

    @Test
    void viewersCanReadButCannotChangeAnything() throws Exception {
        String file = id(createFile(owner, workspace, null, "readme.md", "FILE"));
        String email = "viewer-" + UUID.randomUUID() + "@example.test";
        var viewer = signUpWithEmail("Viewer", email);
        add(email, "VIEWER").andExpect(status().isCreated());

        getAs(viewer, "/api/v1/workspaces/{id}/tree", workspace).andExpect(status().isOk());
        getAs(viewer, "/api/v1/files/{id}/content", file).andExpect(status().isOk());

        createFile(viewer, workspace, null, "new.md", "FILE").andExpect(status().isForbidden());
        perform(viewer, patch("/api/v1/files/" + file), "{'name':'renamed.md','rowVersion':0}").andExpect(status().isForbidden());
        perform(viewer, put("/api/v1/files/" + file + "/content"), "{'text':'defaced'}").andExpect(status().isForbidden());
        mvc.perform(delete("/api/v1/files/{id}", file).param("rowVersion", "0").session(viewer).with(csrf()))
                .andExpect(status().isForbidden());
        perform(viewer, patch("/api/v1/workspaces/" + workspace), "{'name':'Mine'}").andExpect(status().isForbidden());
        perform(viewer, post("/api/v1/workspaces/" + workspace + "/members"), "{'email':'x@example.test','role':'OWNER'}")
                .andExpect(status().isForbidden());

        String ticket = read(perform(viewer, post("/api/v1/realtime/tickets"), "{'fileId':'%s'}", file)
                .andExpect(status().isCreated()), "$.ticket");
        mvc.perform(post("/internal/collab/authorize").header("X-Internal-Token", INTERNAL_TOKEN)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'ticket':'%s','documentName':'%s'}", ticket, file)))
                .andExpect(jsonPath("$.readOnly").value(true));
    }

    @Test
    void roleChangesTakeEffectImmediatelyAndReachOpenConnections() throws Exception {
        String email = "demoted-" + UUID.randomUUID() + "@example.test";
        var person = signUpWithEmail("Demoted", email);
        String userId = read(add(email, "EDITOR"), "$.member.userId");

        perform(owner, patch("/api/v1/workspaces/" + workspace + "/members/" + userId), "{'role':'VIEWER'}")
                .andExpect(status().isOk());

        createFile(person, workspace, null, "after.md", "FILE").andExpect(status().isForbidden());
        verify(collab, timeout(2000)).revoke(eq(UUID.fromString(userId)), eq(UUID.fromString(workspace)), eq("read-only"));
    }

    @Test
    void removedMembersLoseAccessAndTheirConnectionsAreClosed() throws Exception {
        String email = "removed-" + UUID.randomUUID() + "@example.test";
        var person = signUpWithEmail("Removed", email);
        String userId = read(add(email, "EDITOR"), "$.member.userId");

        mvc.perform(delete("/api/v1/workspaces/{w}/members/{u}", workspace, userId).session(owner).with(csrf()))
                .andExpect(status().isNoContent());

        getAs(person, "/api/v1/workspaces/{id}", workspace).andExpect(status().isNotFound());
        verify(collab, timeout(2000)).revoke(eq(UUID.fromString(userId)), eq(UUID.fromString(workspace)), eq("close"));
    }

    @Test
    void theLastOwnerCannotBeRemovedOrDemoted() throws Exception {
        String ownerId = read(getAs(owner, "/api/v1/auth/me"), "$.id");

        perform(owner, patch("/api/v1/workspaces/" + workspace + "/members/" + ownerId), "{'role':'EDITOR'}")
                .andExpect(status().isConflict());
        mvc.perform(delete("/api/v1/workspaces/{w}/members/{u}", workspace, ownerId).session(owner).with(csrf()))
                .andExpect(status().isConflict());
    }

    @Test
    void editorsCannotManageMembers() throws Exception {
        String email = "editor-" + UUID.randomUUID() + "@example.test";
        var editor = signUpWithEmail("Editor", email);
        add(email, "EDITOR");

        perform(editor, post("/api/v1/workspaces/" + workspace + "/members"), "{'email':'y@example.test','role':'VIEWER'}")
                .andExpect(status().isForbidden());
        getAs(editor, "/api/v1/workspaces/{id}/audit", workspace).andExpect(status().isForbidden());
    }

    @Test
    void sensitiveActionsAreAudited() throws Exception {
        String email = "audited-" + UUID.randomUUID() + "@example.test";
        signUpWithEmail("Audited", email);
        String userId = read(add(email, "EDITOR"), "$.member.userId");
        perform(owner, patch("/api/v1/workspaces/" + workspace + "/members/" + userId), "{'role':'VIEWER'}");

        List<String> actions = read(getAs(owner, "/api/v1/workspaces/{id}/audit", workspace), "$[*].action");
        assertThat(actions).containsSubsequence("member.role_changed", "member.added");
    }

    private org.springframework.test.web.servlet.ResultActions add(String email, String role) throws Exception {
        return perform(owner, post("/api/v1/workspaces/" + workspace + "/members"), "{'email':'%s','role':'%s'}", email, role);
    }

    private MockHttpSession signUpWithEmail(String name, String email) throws Exception {
        var result = mvc.perform(post("/api/v1/auth/register").with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'%s','displayName':'%s','password':'correct horse battery'}", email, name)))
                .andExpect(status().isCreated())
                .andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }
}
