package dev.converge.api.common;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.HexFormat;
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

    /** A traceparent for an outgoing call: the same trace, a new span, sampled. */
    public static String childHeader(String traceId) {
        return "00-" + traceId + "-" + random(8) + "-01";
    }

    static String random(int bytes) {
        byte[] raw = new byte[bytes];
        RANDOM.nextBytes(raw);
        return HexFormat.of().formatHex(raw);
    }

    /** Puts the request's trace ID into the logging context and the response. */
    public static class Filter extends OncePerRequestFilter {
        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                throws ServletException, IOException {
            String traceId = traceIdFrom(request.getHeader(HEADER));
            MDC.put(MDC_KEY, traceId);
            response.setHeader("X-Trace-Id", traceId);
            try {
                chain.doFilter(request, response);
            } finally {
                MDC.remove(MDC_KEY);
            }
        }
    }

    /** Sends the current trace on calls to other services. */
    public static class Propagation implements ClientHttpRequestInterceptor {
        @Override
        public ClientHttpResponse intercept(HttpRequest request, byte[] body, ClientHttpRequestExecution execution)
                throws IOException {
            String traceId = MDC.get(MDC_KEY);
            request.getHeaders().set(HEADER, childHeader(traceId != null ? traceId : random(16)));
            return execution.execute(request, body);
        }
    }
}
