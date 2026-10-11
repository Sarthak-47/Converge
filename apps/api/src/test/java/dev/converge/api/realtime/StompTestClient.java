package dev.converge.api.realtime;

import java.lang.reflect.Type;
import java.net.CookieManager;
import java.net.HttpCookie;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import org.springframework.messaging.converter.JacksonJsonMessageConverter;
import org.springframework.messaging.simp.stomp.StompFrameHandler;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.springframework.messaging.simp.stomp.StompSession;
import org.springframework.messaging.simp.stomp.StompSessionHandlerAdapter;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;

/**
 * A signed-in user talking to a running server the way the browser does: HTTP for sign-up and REST calls
 * (session cookie + CSRF header), and STOMP over WebSocket with the same cookie and a same-origin header.
 */
public final class StompTestClient implements AutoCloseable {

    private final String baseUrl;
    private final CookieManager cookies = new CookieManager();
    private final HttpClient http;
    private StompSession session;
    public final BlockingQueue<String> errors = new LinkedBlockingQueue<>();

    private StompTestClient(int port) {
        this.baseUrl = "http://localhost:" + port;
        this.http = HttpClient.newBuilder().cookieHandler(cookies).version(HttpClient.Version.HTTP_1_1).build();
    }

    public static StompTestClient signUp(int port, String name) throws Exception {
        StompTestClient client = new StompTestClient(port);
        String email = name.toLowerCase() + "-" + UUID.randomUUID() + "@example.test";
        client.send("POST", "/api/v1/auth/register",
                "{\"email\":\"" + email + "\",\"displayName\":\"" + name + "\",\"password\":\"correct horse battery\"}", 201);
        return client;
    }

    /**
     * Sends an HTTP request with the CSRF header, failing unless the expected status comes back. Spring clears
     * the token cookie when it rotates the token at sign-in, so a missing cookie means "fetch a fresh one".
     */
    public String send(String method, String path, String json, int expectedStatus) throws Exception {
        if (!method.equals("GET") && cookie("XSRF-TOKEN") == null) {
            http.send(HttpRequest.newBuilder(URI.create(baseUrl + "/api/v1/auth/csrf")).GET().build(),
                    HttpResponse.BodyHandlers.discarding());
        }
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .header("Content-Type", "application/json")
                .method(method, json == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json));
        String token = cookie("XSRF-TOKEN");
        if (token != null) {
            request.header("X-XSRF-TOKEN", token);
        }
        HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != expectedStatus) {
            throw new AssertionError(method + " " + path + " returned " + response.statusCode() + ": " + response.body());
        }
        return response.body();
    }

    public String createWorkspace(String name) throws Exception {
        String body = send("POST", "/api/v1/workspaces", "{\"name\":\"" + name + "\"}", 201);
        return com.jayway.jsonpath.JsonPath.read(body, "$.id");
    }

    public String createFile(String workspaceId, String name) throws Exception {
        String body = send("POST", "/api/v1/files",
                "{\"workspaceId\":\"" + workspaceId + "\",\"name\":\"" + name + "\",\"kind\":\"FILE\"}", 201);
        return com.jayway.jsonpath.JsonPath.read(body, "$.id");
    }

    public StompTestClient connect() throws Exception {
        return connectFrom(baseUrl);
    }

    /** Opens the socket claiming to come from {@code origin}, as a page on that origin would. */
    public StompTestClient connectFrom(String origin) throws Exception {
        WebSocketStompClient stomp = new WebSocketStompClient(new StandardWebSocketClient());
        stomp.setMessageConverter(new JacksonJsonMessageConverter());
        WebSocketHttpHeaders headers = new WebSocketHttpHeaders();
        headers.add("Cookie", "CONVERGE_SESSION=" + cookie("CONVERGE_SESSION"));
        headers.add("Origin", origin);
        session = stomp.connectAsync(baseUrl.replace("http", "ws") + "/ws", headers, new StompSessionHandlerAdapter() {
            @Override
            public void handleFrame(StompHeaders frameHeaders, Object payload) {
                errors.add(String.valueOf(frameHeaders.getFirst("message")));
            }

            @Override
            public Type getPayloadType(StompHeaders frameHeaders) {
                return byte[].class;
            }
        }).get(10, TimeUnit.SECONDS);
        return this;
    }

    /** Subscribes and returns a queue that receives every message on the destination as a JSON map. */
    public BlockingQueue<Map<String, Object>> subscribe(String destination) throws InterruptedException {
        BlockingQueue<Map<String, Object>> received = new LinkedBlockingQueue<>();
        session.subscribe(destination, new StompFrameHandler() {
            @Override
            public Type getPayloadType(StompHeaders headers) {
                return Map.class;
            }

            @Override
            @SuppressWarnings("unchecked")
            public void handleFrame(StompHeaders headers, Object payload) {
                received.add((Map<String, Object>) payload);
            }
        });
        Thread.sleep(200); // let the SUBSCRIBE reach the broker before the test publishes
        return received;
    }

    public void sendStomp(String destination, Object payload) {
        session.send(destination, payload);
    }

    public boolean isConnected() {
        return session != null && session.isConnected();
    }

    private String cookie(String name) {
        return cookies.getCookieStore().getCookies().stream()
                .filter(c -> c.getName().equals(name))
                .map(HttpCookie::getValue)
                .findFirst()
                .orElse(null);
    }

    @Override
    public void close() {
        if (session != null && session.isConnected()) {
            session.disconnect();
        }
    }
}
