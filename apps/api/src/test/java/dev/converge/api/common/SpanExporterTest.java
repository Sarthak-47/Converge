package dev.converge.api.common;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import org.junit.jupiter.api.Test;

import com.sun.net.httpserver.HttpServer;

/** Span export over OTLP/HTTP JSON (design §16.3), against a local stand-in for a collector. */
class SpanExporterTest {

    @Test
    void sendsFinishedSpansAsOtlpJsonToTheTracesPath() throws Exception {
        List<String> paths = new CopyOnWriteArrayList<>();
        List<String> bodies = new CopyOnWriteArrayList<>();
        HttpServer collector = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        collector.createContext("/", exchange -> {
            paths.add(exchange.getRequestURI().getPath());
            bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        collector.start();
        try {
            SpanExporter exporter = SpanExporter.start("http://127.0.0.1:" + collector.getAddress().getPort() + "/", "converge-api", 60_000);
            SpanExporter.record(new SpanExporter.Span("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", "00f067aa0ba902b7",
                    "PUT /api/v1/files/{id}/content", SpanExporter.KIND_SERVER, 1_000_000_000L, 1_250_000_000L, false,
                    Map.of("http.response.status_code", 204, "http.route", "/api/v1/files/{id}/content")));
            exporter.stop();

            assertThat(paths).containsExactly("/v1/traces");
            String body = bodies.getFirst();
            assertThat(body).contains("\"service.name\"", "\"converge-api\"");
            assertThat(body).contains("\"traceId\":\"0af7651916cd43dd8448eb211c80319c\"", "\"parentSpanId\":\"00f067aa0ba902b7\"");
            assertThat(body).contains("\"startTimeUnixNano\":\"1000000000\"", "\"kind\":2", "\"intValue\":\"204\"");
            assertThat(SpanExporter.enabled()).isFalse();
        } finally {
            collector.stop(0);
        }
    }

    @Test
    void recordingWithoutAnEndpointDoesNothing() {
        SpanExporter.record(new SpanExporter.Span("a".repeat(32), "b".repeat(16), null, "x", 1, 0, 1, false, Map.of()));
        assertThat(SpanExporter.enabled()).isFalse();
    }

    @Test
    void routesNameIdsGenerically() {
        assertThat(TraceContext.route("/api/v1/files/0b4d5c1e-1111-4a2b-9c3d-0123456789ab/content")).isEqualTo("/api/v1/files/{id}/content");
        assertThat(TraceContext.route("/api/v1/workspaces/7/audit")).isEqualTo("/api/v1/workspaces/{id}/audit");
    }

    @Test
    void outgoingCallsNameTheCallersSpanAsParent() {
        String header = TraceContext.childHeader("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331");
        assertThat(header).isEqualTo("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
        assertThat(TraceContext.parentSpanFrom(header)).isEqualTo("b7ad6b7169203331");
        assertThat(TraceContext.parentSpanFrom("garbage")).isNull();
    }
}
