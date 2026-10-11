package dev.converge.api.file;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.web.MockHttpSession;

import dev.converge.api.IntegrationTest;

class FileApiTest extends IntegrationTest {

    private MockHttpSession asha;
    private String workspace;

    @BeforeEach
    void setUp() throws Exception {
        asha = signUp("Asha");
        workspace = createWorkspace(asha, "Project");
    }

    @Test
    void createsNestedFilesWithPathsAndLanguages() throws Exception {
        String src = id(createFile(asha, workspace, null, "src", "FOLDER").andExpect(status().isCreated()));
        createFile(asha, workspace, src, "app.ts", "FILE")
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.path").value("src/app.ts"))
                .andExpect(jsonPath("$.language").value("typescript"));

        List<String> paths = read(getAs(asha, "/api/v1/workspaces/{id}/tree", workspace), "$[*].path");
        assertThat(paths).containsExactly("src", "src/app.ts");
    }

    @Test
    void duplicateNamesInOneFolderConflict() throws Exception {
        createFile(asha, workspace, null, "README.md", "FILE").andExpect(status().isCreated());
        createFile(asha, workspace, null, "README.md", "FILE").andExpect(status().isConflict());
    }

    @ParameterizedTest
    @ValueSource(strings = {"..", "a/b", "a\\\\b", "con", "NUL.txt", "trailing.", "what?", "pipe|name"})
    void rejectsNamesThatAreInvalidOnSomeDesktopOs(String name) throws Exception {
        createFile(asha, workspace, null, name, "FILE").andExpect(status().isBadRequest());
    }

    @Test
    void movingAFolderRewritesEveryDescendantPath() throws Exception {
        String src = id(createFile(asha, workspace, null, "src", "FOLDER"));
        String lib = id(createFile(asha, workspace, src, "lib", "FOLDER"));
        createFile(asha, workspace, lib, "util.ts", "FILE");
        String pkg = id(createFile(asha, workspace, null, "packages", "FOLDER"));

        perform(asha, patch("/api/v1/files/" + src), "{'name':'core','parentId':'%s','rowVersion':0}", pkg)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.path").value("packages/core"));

        List<String> paths = read(getAs(asha, "/api/v1/workspaces/{id}/tree", workspace), "$[*].path");
        assertThat(paths).containsExactly("packages", "packages/core", "packages/core/lib", "packages/core/lib/util.ts");
    }

    @Test
    void folderCannotMoveIntoItsOwnDescendant() throws Exception {
        String a = id(createFile(asha, workspace, null, "a", "FOLDER"));
        String b = id(createFile(asha, workspace, a, "b", "FOLDER"));

        perform(asha, patch("/api/v1/files/" + a), "{'parentId':'%s','rowVersion':0}", b)
                .andExpect(status().isBadRequest());
    }

    @Test
    void staleRowVersionIsRejected() throws Exception {
        String file = id(createFile(asha, workspace, null, "one.txt", "FILE"));
        perform(asha, patch("/api/v1/files/" + file), "{'name':'two.txt','rowVersion':0}").andExpect(status().isOk());

        // A second client still holding version 0 must not clobber the rename.
        perform(asha, patch("/api/v1/files/" + file), "{'name':'three.txt','rowVersion':0}")
                .andExpect(status().isConflict());
    }

    @Test
    void deletingAFolderSoftDeletesItsContentsAndFreesThePath() throws Exception {
        String docs = id(createFile(asha, workspace, null, "docs", "FOLDER"));
        createFile(asha, workspace, docs, "guide.md", "FILE");

        mvc.perform(delete("/api/v1/files/{id}", docs).param("rowVersion", "0").session(asha)
                        .with(org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf()))
                .andExpect(status().isNoContent());

        getAs(asha, "/api/v1/workspaces/{id}/tree", workspace).andExpect(jsonPath("$.length()").value(0));
        createFile(asha, workspace, null, "docs", "FOLDER").andExpect(status().isCreated());
    }

    @Test
    void savesAndLoadsContentWithVersions() throws Exception {
        String file = id(createFile(asha, workspace, null, "main.py", "FILE"));

        perform(asha, put("/api/v1/files/" + file + "/content"), "{'text':'print(1)','baseVersion':0}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(1));

        getAs(asha, "/api/v1/files/{id}/content", file)
                .andExpect(jsonPath("$.text").value("print(1)"))
                .andExpect(jsonPath("$.version").value(1))
                .andExpect(jsonPath("$.language").value("python"));
    }

    /** The lost-update problem that real-time sync (Phase 3) exists to solve, guarded here by versioning. */
    @Test
    void staleSaveIsRejectedInsteadOfOverwritingNewerText() throws Exception {
        String file = id(createFile(asha, workspace, null, "notes.md", "FILE"));
        perform(asha, put("/api/v1/files/" + file + "/content"), "{'text':'Asha was here','baseVersion':0}")
                .andExpect(status().isOk());

        perform(asha, put("/api/v1/files/" + file + "/content"), "{'text':'Ben overwrites','baseVersion':0}")
                .andExpect(status().isConflict());
        getAs(asha, "/api/v1/files/{id}/content", file).andExpect(jsonPath("$.text").value("Asha was here"));
    }

    @Test
    void outsidersCannotReadOrWriteFiles() throws Exception {
        var mallory = signUp("Mallory");
        String file = id(createFile(asha, workspace, null, "secret.txt", "FILE"));

        getAs(mallory, "/api/v1/files/{id}/content", file).andExpect(status().isNotFound());
        perform(mallory, put("/api/v1/files/" + file + "/content"), "{'text':'pwned','baseVersion':0}")
                .andExpect(status().isNotFound());
        createFile(mallory, workspace, null, "evil.txt", "FILE").andExpect(status().isNotFound());
    }
}
