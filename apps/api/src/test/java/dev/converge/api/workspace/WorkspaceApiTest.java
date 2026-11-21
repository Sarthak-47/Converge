package dev.converge.api.workspace;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;

import dev.converge.api.IntegrationTest;

class WorkspaceApiTest extends IntegrationTest {

    @Test
    void creatorBecomesOwner() throws Exception {
        var asha = signUp("Asha");
        String id = createWorkspace(asha, "Distributed Systems Lab");

        getAs(asha, "/api/v1/workspaces/{id}", id)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("OWNER"))
                .andExpect(jsonPath("$.slug").value("distributed-systems-lab"))
                .andExpect(jsonPath("$.status").value("ACTIVE"));
        getAs(asha, "/api/v1/workspaces").andExpect(jsonPath("$[0].id").value(id));
    }

    @Test
    void slugsAreUniquePerOwner() throws Exception {
        var asha = signUp("Asha");
        createWorkspace(asha, "Notes");
        String second = createWorkspace(asha, "Notes!");

        getAs(asha, "/api/v1/workspaces/{id}", second).andExpect(jsonPath("$.slug").value("notes-2"));
    }

    @Test
    void nonMembersCannotSeeAWorkspace() throws Exception {
        var asha = signUp("Asha");
        var mallory = signUp("Mallory");
        String id = createWorkspace(asha, "Private");

        // 404, not 403: outsiders cannot even learn that the workspace exists.
        getAs(mallory, "/api/v1/workspaces/{id}", id).andExpect(status().isNotFound());
        getAs(mallory, "/api/v1/workspaces/{id}/tree", id).andExpect(status().isNotFound());
        getAs(mallory, "/api/v1/workspaces").andExpect(jsonPath("$.length()").value(0));
        perform(mallory, patch("/api/v1/workspaces/" + id), "{'name':'Mine now'}").andExpect(status().isNotFound());
    }

    @Test
    void ownerCanRenameAndArchive() throws Exception {
        var asha = signUp("Asha");
        String id = createWorkspace(asha, "Old name");

        perform(asha, patch("/api/v1/workspaces/" + id), "{'name':'New name','status':'ARCHIVED'}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("New name"))
                .andExpect(jsonPath("$.status").value("ARCHIVED"));
    }

    @Test
    void anArchivedWorkspaceIsReadOnlyUntilAnOwnerUnarchivesIt() throws Exception {
        var asha = signUp("Asha");
        String id = createWorkspace(asha, "Old project");
        createFile(asha, id, null, "notes.txt", "FILE").andExpect(status().isCreated());

        perform(asha, patch("/api/v1/workspaces/" + id), "{'status':'ARCHIVED'}").andExpect(status().isOk());
        // Open editors are turned read-only at once, not on their next reconnect.
        org.mockito.Mockito.verify(collab).revoke(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.eq(java.util.UUID.fromString(id)), org.mockito.ArgumentMatchers.eq("read-only"));

        // Reading still works; writing is refused with a reason.
        getAs(asha, "/api/v1/workspaces/{id}/tree", id).andExpect(status().isOk());
        createFile(asha, id, null, "more.txt", "FILE")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value("This workspace is archived; an owner can unarchive it"));
        // Settings stay open, so the owner can rename it and bring it back.
        perform(asha, patch("/api/v1/workspaces/" + id), "{'name':'Old project (2025)','status':'ACTIVE'}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ACTIVE"));
        createFile(asha, id, null, "more.txt", "FILE").andExpect(status().isCreated());
    }

    @Test
    void slugifyHandlesAccentsAndSymbols() {
        org.assertj.core.api.Assertions.assertThat(WorkspaceService.slugify("Café  Déjà-vu!!")).isEqualTo("cafe-deja-vu");
        org.assertj.core.api.Assertions.assertThat(WorkspaceService.slugify("***")).isEqualTo("workspace");
    }
}
