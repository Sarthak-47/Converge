package dev.converge.api.common;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import tools.jackson.databind.json.JsonMapper;

/**
 * Sends finished spans to an OpenTelemetry collector or tracing backend over OTLP/HTTP with JSON bodies
 * (design §16.3), when {@code OTEL_EXPORTER_OTLP_ENDPOINT} is set. No SDK: the services already carry W3C trace
 * context themselves, so all that was missing is writing the spans down. Spans are batched and sent from a
 * background thread; when the backend is slow or down they are dropped, never queued without bound, and
 * requests never wait for them.
 */
public final class SpanExporter {

    /** One finished span. Times are epoch nanoseconds; ids are lowercase hex. */
    public record Span(String traceId, String spanId, String parentSpanId, String name, int kind,
            long startNanos, long endNanos, boolean error, Map<String, Object> attributes) {
    }

    public static final int KIND_SERVER = 2;
    public static final int KIND_INTERNAL = 1;

    private static final Logger log = LoggerFactory.getLogger(SpanExporter.class);
    private static final int MAX_QUEUED = 4096;
    private static final int MAX_BATCH = 512;

    private static volatile SpanExporter instance;

    private final URI endpoint;
    private final String serviceName;
    private final BlockingQueue<Span> queue = new ArrayBlockingQueue<>(MAX_QUEUED);
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final JsonMapper json = JsonMapper.builder().build();
    private final ScheduledExecutorService sender;
    private final AtomicLong dropped = new AtomicLong();

    SpanExporter(String endpoint, String serviceName, long flushMillis) {
        String base = endpoint.endsWith("/") ? endpoint.substring(0, endpoint.length() - 1) : endpoint;
        this.endpoint = URI.create(base.endsWith("/v1/traces") ? base : base + "/v1/traces");
        this.serviceName = serviceName;
        this.sender = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "otlp-span-exporter");
            thread.setDaemon(true);
            return thread;
        });
        sender.scheduleWithFixedDelay(this::flush, flushMillis, flushMillis, TimeUnit.MILLISECONDS);
    }

    /** Turns export on for this process; called once at startup when an endpoint is configured. */
    public static synchronized SpanExporter start(String endpoint, String serviceName, long flushMillis) {
        if (instance != null) instance.stop();
        instance = new SpanExporter(endpoint, serviceName, flushMillis);
        log.info("Exporting spans over OTLP to {}", instance.endpoint);
        return instance;
    }

    /** Records a span if export is on; otherwise does nothing. Never blocks. */
    public static void record(Span span) {
        SpanExporter exporter = instance;
        if (exporter != null && !exporter.queue.offer(span)) exporter.dropped.incrementAndGet();
    }

    public static boolean enabled() {
        return instance != null;
    }

    /** Sends everything queued so far. */
    public void flush() {
        try {
            List<Span> batch = new ArrayList<>();
            while (queue.drainTo(batch, MAX_BATCH) > 0) {
                send(batch);
                batch.clear();
            }
            long lost = dropped.getAndSet(0);
            if (lost > 0) log.warn("Dropped {} spans: the export queue was full", lost);
        } catch (RuntimeException e) {
            log.warn("Span export failed: {}", e.getMessage());
        }
    }

    public synchronized void stop() {
        sender.shutdown();
        flush();
        if (instance == this) instance = null;
    }

    private void send(List<Span> batch) {
        String body = json.writeValueAsString(payload(batch));
        HttpRequest request = HttpRequest.newBuilder(endpoint)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        try {
            HttpResponse<Void> response = http.send(request, HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() >= 300) log.warn("The span backend answered {} for {} spans", response.statusCode(), batch.size());
        } catch (java.io.IOException e) {
            log.warn("Could not reach the span backend ({} spans dropped): {}", batch.size(), e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** The OTLP/JSON request body: one resource (this service), one scope, the spans. */
    Map<String, Object> payload(List<Span> spans) {
        List<Map<String, Object>> encoded = new ArrayList<>();
        for (Span span : spans) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("traceId", span.traceId());
            s.put("spanId", span.spanId());
            if (span.parentSpanId() != null) s.put("parentSpanId", span.parentSpanId());
            s.put("name", span.name());
            s.put("kind", span.kind());
            // 64-bit nanosecond times are strings in OTLP/JSON, so JavaScript backends read them exactly.
            s.put("startTimeUnixNano", Long.toString(span.startNanos()));
            s.put("endTimeUnixNano", Long.toString(span.endNanos()));
            s.put("attributes", attributes(span.attributes()));
            s.put("status", Map.of("code", span.error() ? 2 : 1));
            encoded.add(s);
        }
        return Map.of("resourceSpans", List.of(Map.of(
                "resource", Map.of("attributes", attributes(Map.of("service.name", serviceName))),
                "scopeSpans", List.of(Map.of("scope", Map.of("name", "converge"), "spans", encoded)))));
    }

    private static List<Map<String, Object>> attributes(Map<String, Object> values) {
        List<Map<String, Object>> list = new ArrayList<>();
        values.forEach((key, value) -> {
            if (value == null) return;
            Map<String, Object> typed = value instanceof Number n
                    ? Map.of("intValue", Long.toString(n.longValue()))
                    : value instanceof Boolean b ? Map.of("boolValue", b) : Map.of("stringValue", value.toString());
            list.add(Map.of("key", key, "value", typed));
        });
        return list;
    }
}
