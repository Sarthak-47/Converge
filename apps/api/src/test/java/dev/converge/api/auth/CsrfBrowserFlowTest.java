package dev.converge.api.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.CookieManager;
import java.net.HttpCookie;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import dev.converge.api.HttpIntegrationTest;

/**
 * The CSRF flow exactly as the browser client performs it, over real HTTP (MockMvc's test helpers replace the
 * token repository, so they cannot show what a browser actually receives).
 */
class CsrfBrowserFlowTest extends HttpIntegrationTest {

    private final CookieManager cookies = new CookieManager();
    private final HttpClient http = HttpClient.newBuilder().cookieHandler(cookies).build();

    @Test
    void tokenCookieIsReadableByScriptAndRequiredForMutations() throws Exception {
        HttpResponse<Void> csrf = http.send(get("/api/v1/auth/csrf"), HttpResponse.BodyHandlers.discarding());
        assertThat(csrf.statusCode()).isEqualTo(204);
        List<String> setCookies = csrf.headers().allValues("Set-Cookie");
        assertThat(setCookies).anySatisfy(c -> assertThat(c).startsWith("XSRF-TOKEN=").doesNotContainIgnoringCase("HttpOnly"));
        String token = cookie("XSRF-TOKEN");

        String body = "{\"email\":\"csrf-" + UUID.randomUUID() + "@example.test\",\"displayName\":\"C\",\"password\":\"correct horse battery\"}";
        assertThat(http.send(post("/api/v1/auth/register", body, null), HttpResponse.BodyHandlers.discarding()).statusCode())
                .as("a mutation without the header is rejected").isEqualTo(403);
        assertThat(http.send(post("/api/v1/auth/register", body, token), HttpResponse.BodyHandlers.discarding()).statusCode())
                .as("the same mutation with the header succeeds").isEqualTo(201);

        HttpResponse<String> me = http.send(get("/api/v1/auth/me"), HttpResponse.BodyHandlers.ofString());
        assertThat(me.statusCode()).isEqualTo(200);
        assertThat(me.headers().allValues("Set-Cookie")).noneMatch(c -> c.contains("CONVERGE_SESSION") && !c.contains("HttpOnly"));
    }

    @Test
    void sessionCookieIsHttpOnlyAndSameSiteLax() throws Exception {
        http.send(get("/api/v1/auth/csrf"), HttpResponse.BodyHandlers.discarding());
        String body = "{\"email\":\"cookie-" + UUID.randomUUID() + "@example.test\",\"displayName\":\"C\",\"password\":\"correct horse battery\"}";
        HttpResponse<Void> register = http.send(post("/api/v1/auth/register", body, cookie("XSRF-TOKEN")),
                HttpResponse.BodyHandlers.discarding());

        assertThat(register.headers().allValues("Set-Cookie"))
                .anySatisfy(c -> assertThat(c).startsWith("CONVERGE_SESSION=").contains("HttpOnly").containsIgnoringCase("SameSite=Lax"));
    }

    private HttpRequest get(String path) {
        return HttpRequest.newBuilder(URI.create("http://localhost:" + port() + path)).GET().build();
    }

    private HttpRequest post(String path, String json, String token) {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port() + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json));
        if (token != null) {
            request.header("X-XSRF-TOKEN", token);
        }
        return request.build();
    }

    private String cookie(String name) {
        return cookies.getCookieStore().getCookies().stream()
                .filter(c -> c.getName().equals(name)).map(HttpCookie::getValue).findFirst().orElseThrow();
    }
}
