package dev.converge.api.health;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.health.contributor.Status;

class CollabHealthIndicatorTest {

    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void upWhenCollabReportsHealthy() throws IOException {
        String baseUrl = serve(200, "{\"status\":\"UP\"}");

        assertThat(new CollabHealthIndicator(baseUrl).health(true).getStatus()).isEqualTo(Status.UP);
    }

    @Test
    void downWhenCollabReportsItsDependenciesDown() throws IOException {
        String baseUrl = serve(503, "{\"status\":\"DOWN\"}");

        assertThat(new CollabHealthIndicator(baseUrl).health(true).getStatus()).isEqualTo(Status.DOWN);
    }

    @Test
    void downWhenCollabIsUnreachable() {
        assertThat(new CollabHealthIndicator("http://127.0.0.1:1").health(true).getStatus()).isEqualTo(Status.DOWN);
    }

    private String serve(int status, String body) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/health", exchange -> {
            // Mirror the collaboration server: any Upgrade header is treated as a bad WebSocket handshake.
            boolean upgrade = exchange.getRequestHeaders().containsKey("Upgrade");
            byte[] bytes = (upgrade ? "Invalid Upgrade header" : body).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(upgrade ? 400 : status, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }
}
