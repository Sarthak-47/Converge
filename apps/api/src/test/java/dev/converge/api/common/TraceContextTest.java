package dev.converge.api.common;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.http.HttpMethod;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.mock.http.client.MockClientHttpResponse;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/** Trace context in and out of the API (design §16.3); plain unit tests, no containers. */
class TraceContextTest {

    private static final String TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

    @AfterEach
    void clear() {
        MDC.clear();
    }

    @Test
    void continuesAValidTraceAndStartsOneOtherwise() {
        assertThat(TraceContext.traceIdFrom("00-" + TRACE + "-00f067aa0ba902b7-01")).isEqualTo(TRACE);
        for (String bad : new String[] {null, "", "garbage", "00-" + "0".repeat(32) + "-00f067aa0ba902b7-01"}) {
            assertThat(TraceContext.traceIdFrom(bad)).matches("[0-9a-f]{32}").isNotEqualTo(TRACE);
        }
    }

    @Test
    void theFilterLogsUnderTheCallersTraceAndReportsIt() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/workspaces");
        request.addHeader("traceparent", "00-" + TRACE + "-00f067aa0ba902b7-01");
        MockHttpServletResponse response = new MockHttpServletResponse();
        String[] seen = new String[1];
        new TraceContext.Filter().doFilter(request, response, new MockFilterChain() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest req, jakarta.servlet.ServletResponse res) {
                seen[0] = MDC.get(TraceContext.MDC_KEY);
            }
        });
        assertThat(seen[0]).isEqualTo(TRACE);
        assertThat(response.getHeader("X-Trace-Id")).isEqualTo(TRACE);
        assertThat(MDC.get(TraceContext.MDC_KEY)).isNull();
    }

    @Test
    void outgoingCallsCarryTheSameTraceWithANewSpan() throws Exception {
        MDC.put(TraceContext.MDC_KEY, TRACE);
        MockClientHttpRequest request = new MockClientHttpRequest(HttpMethod.POST, URI.create("http://collab:1234/internal/x"));
        new TraceContext.Propagation().intercept(request, new byte[0], (req, body) -> new MockClientHttpResponse());
        assertThat(request.getHeaders().getFirst("traceparent")).matches("00-" + TRACE + "-[0-9a-f]{16}-01");
    }
}
