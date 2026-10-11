package dev.converge.api.realtime;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.ResultActions;

import dev.converge.api.IntegrationTest;

/** Collaboration tickets (design §14.4): bound to one user and file, short-lived, single-use. */
class TicketApiTest extends IntegrationTest {

    private MockHttpSession asha;
    private String workspace;
    private String file;

    @BeforeEach
    void setUp() throws Exception {
        asha = signUp("Asha");
        workspace = createWorkspace(asha, "Tickets");
        file = id(createFile(asha, workspace, null, "live.ts", "FILE"));
    }

    @Test
    void memberCanRedeemATicketOnceForItsFile() throws Exception {
        String ticket = issue(asha, file);

        redeem(ticket, file, INTERNAL_TOKEN)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.fileId").value(file))
                .andExpect(jsonPath("$.workspaceId").value(workspace))
                .andExpect(jsonPath("$.role").value("OWNER"))
                .andExpect(jsonPath("$.readOnly").value(false))
                .andExpect(jsonPath("$.displayName").value("Asha"));

        redeem(ticket, file, INTERNAL_TOKEN).andExpect(status().isUnauthorized());
    }

    @Test
    void ticketIsBoundToItsFile() throws Exception {
        String other = id(createFile(asha, workspace, null, "other.ts", "FILE"));
        String ticket = issue(asha, file);

        redeem(ticket, other, INTERNAL_TOKEN).andExpect(status().isForbidden());
    }

    @Test
    void expiredTicketsAreRefused() throws Exception {
        String ticket = issue(asha, file);
        jdbc.sql("update realtime_tickets set expires_at = now() - interval '1 second'").update();

        redeem(ticket, file, INTERNAL_TOKEN).andExpect(status().isUnauthorized());
    }

    @Test
    void outsidersCannotGetTickets() throws Exception {
        var mallory = signUp("Mallory");
        perform(mallory, post("/api/v1/realtime/tickets"), "{'fileId':'%s'}", file).andExpect(status().isNotFound());
    }

    @Test
    void foldersHaveNoTickets() throws Exception {
        String folder = id(createFile(asha, workspace, null, "src", "FOLDER"));
        perform(asha, post("/api/v1/realtime/tickets"), "{'fileId':'%s'}", folder).andExpect(status().isNotFound());
    }

    @Test
    void internalEndpointRequiresTheServiceToken() throws Exception {
        String ticket = issue(asha, file);

        redeem(ticket, file, null).andExpect(status().isUnauthorized());
        redeem(ticket, file, "wrong-token").andExpect(status().isUnauthorized());
        redeem(ticket, file, INTERNAL_TOKEN).andExpect(status().isOk());
    }

    @Test
    void unknownTicketsAreRefused() throws Exception {
        redeem("not-a-real-ticket", file, INTERNAL_TOKEN).andExpect(status().isUnauthorized());
    }

    private String issue(MockHttpSession session, String fileId) throws Exception {
        return read(perform(session, post("/api/v1/realtime/tickets"), "{'fileId':'%s'}", fileId)
                .andExpect(status().isCreated()), "$.ticket");
    }

    private ResultActions redeem(String ticket, String documentName, String token) throws Exception {
        var request = post("/internal/collab/authorize")
                .contentType(MediaType.APPLICATION_JSON)
                .content(json("{'ticket':'%s','documentName':'%s'}", ticket, documentName));
        if (token != null) {
            request.header(InternalTokenFilter.HEADER, token);
        }
        return mvc.perform(request);
    }
}
