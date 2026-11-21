package dev.converge.api.common;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.MDC;
import org.springframework.http.HttpRequest;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * W3C trace context across the services (design §16.3). Each request continues the caller's trace (or starts
 * one); the trace ID goes into the logging context, so every log line written while handling the request
 * carries it, and calls to other services pass it on. The Node services do the same with the same header,
 * so one restore or agent turn can be followed through every service's logs.
 */
public final class TraceContext {

    public static final String HEADER = "traceparent";
    public static final String MDC_KEY = "traceId";
    /** This service's own span for the current request: the parent of every call it makes. */
    public static final String SPAN_KEY = "spanId";
    private static final Pattern ID = Pattern.compile("(?<=/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\\d+)(?=/|$)");
    private static final Pattern TRACEPARENT = Pattern.compile("^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$");
    private static final SecureRandom RANDOM = new SecureRandom();

    private TraceContext() {
    }

    /** The caller's trace ID, or a new one when the header is missing or invalid. */
    public static String traceIdFrom(String header) {
        if (header != null) {
            Matcher match = TRACEPARENT.matcher(header.strip());
            if (match.matches() && !match.group(1).chars().allMatch(c -> c == '0')) return match.group(1);
        }
        return random(16);
    }

    /** The caller's span ID, or null when the header is missing or invalid. */
    public static String parentSpanFrom(String header) {
        if (header == null) return null;
        Matcher match = TRACEPARENT.matcher(header.strip());
        return match.matches() && !match.group(2).chars().allMatch(c -> c == '0') ? match.group(2) : null;
    }

    /** A traceparent for an outgoing call: the same trace, with the given span (the caller's own) as parent. */
    public static String childHeader(String traceId, String spanId) {
        return "00-" + traceId + "-" + (spanId != null ? spanId : random(8)) + "-01";
    }

    /** A traceparent for an outgoing call outside any request: the same trace, a new span, sampled. */
    public static String childHeader(String traceId) {
        return childHeader(traceId, null);
    }

    /** A request path with ids replaced, so spans for the same route share one name. */
    public static String route(String path) {
        return ID.matcher(path).replaceAll("{id}");
    }

    public static String random(int bytes) {
        byte[] raw = new byte[bytes];
        RANDOM.nextBytes(raw);
        return HexFormat.of().formatHex(raw);
    }

    /** Puts the request's trace ID into the logging context and the response. */
    public static class Filter extends OncePerRequestFilter {
        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                throws ServletException, IOException {
            String header = request.getHeader(HEADER);
            String traceId = traceIdFrom(header);
            String spanId = random(8);
            MDC.put(MDC_KEY, traceId);
            MDC.put(SPAN_KEY, spanId);
            response.setHeader("X-Trace-Id", traceId);
            long start = System.currentTimeMillis() * 1_000_000L;
            boolean failed = false;
            try {
                chain.doFilter(request, response);
            } catch (IOException | ServletException | RuntimeException e) {
                failed = true;
                throw e;
            } finally {
                MDC.remove(MDC_KEY);
                MDC.remove(SPAN_KEY);
                String path = request.getRequestURI();
                // Health and metrics scrapes would bury the requests worth reading.
                if (SpanExporter.enabled() && !path.startsWith("/actuator") && !path.startsWith("/api/actuator")) {
                    int status = failed ? 500 : response.getStatus();
                    Object pattern = request.getAttribute("org.springframework.web.servlet.HandlerMapping.bestMatchingPattern");
                    String route = pattern != null ? pattern.toString() : route(path);
                    Map<String, Object> attributes = new LinkedHashMap<>();
                    attributes.put("http.request.method", request.getMethod());
                    attributes.put("http.route", route);
                    attributes.put("http.response.status_code", status);
                    SpanExporter.record(new SpanExporter.Span(traceId, spanId, parentSpanFrom(header),
                            request.getMethod() + " " + route, SpanExporter.KIND_SERVER, start,
                            System.currentTimeMillis() * 1_000_000L, status >= 500, attributes));
                }
            }
        }
    }

    /** Sends the current trace on calls to other services. */
    public static class Propagation implements ClientHttpRequestInterceptor {
        @Override
        public ClientHttpResponse intercept(HttpRequest request, byte[] body, ClientHttpRequestExecution execution)
                throws IOException {
            String traceId = MDC.get(MDC_KEY);
            request.getHeaders().set(HEADER, traceId != null ? childHeader(traceId, MDC.get(SPAN_KEY)) : childHeader(random(16)));
            return execution.execute(request, body);
        }
    }
}
