package dev.converge.api.auth;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import dev.converge.api.IntegrationTest;

class AuthApiTest extends IntegrationTest {

    @Test
    void registeredUserIsSignedIn() throws Exception {
        var session = signUp("Asha");

        getAs(session, "/api/v1/auth/me")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Asha"))
                .andExpect(jsonPath("$.passwordHash").doesNotExist());
    }

    @Test
    void duplicateEmailIsRejectedCaseInsensitively() throws Exception {
        String body = json("{'email':'dup@example.test','displayName':'A','password':'correct horse battery'}");
        mvc.perform(post("/api/v1/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated());
        mvc.perform(post("/api/v1/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(body.replace("dup@", "DUP@")))
                .andExpect(status().isConflict());
    }

    @Test
    void loginWithWrongPasswordIsUnauthorized() throws Exception {
        mvc.perform(post("/api/v1/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'ben@example.test','displayName':'Ben','password':'correct horse battery'}")))
                .andExpect(status().isCreated());

        mvc.perform(post("/api/v1/auth/login").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'ben@example.test','password':'wrong password!'}")))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.detail").value("Invalid email or password"));
        mvc.perform(post("/api/v1/auth/login").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'BEN@example.test','password':'correct horse battery'}")))
                .andExpect(status().isOk());
    }

    @Test
    void shortPasswordIsRejected() throws Exception {
        mvc.perform(post("/api/v1/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'email':'c@example.test','displayName':'C','password':'short'}")))
                .andExpect(status().isBadRequest());
    }

    @Test
    void apiRequiresAuthentication() throws Exception {
        mvc.perform(get("/api/v1/workspaces")).andExpect(status().isUnauthorized());
    }

    @Test
    void mutatingRequestsRequireCsrfToken() throws Exception {
        var session = signUp("Dev");
        mvc.perform(post("/api/v1/workspaces").session(session).contentType(MediaType.APPLICATION_JSON)
                        .content(json("{'name':'No token'}")))
                .andExpect(status().isForbidden());
    }

    @Test
    void healthIsPublic() throws Exception {
        mvc.perform(get("/api/actuator/health")).andExpect(status().isOk());
    }
}
