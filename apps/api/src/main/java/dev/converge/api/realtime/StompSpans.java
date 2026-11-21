package dev.converge.api.realtime;

import java.util.LinkedHashMap;
import java.util.Map;

import org.slf4j.MDC;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageHandler;
import org.springframework.messaging.simp.annotation.support.SimpAnnotationMethodMessageHandler;
import org.springframework.messaging.simp.broker.AbstractBrokerMessageHandler;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ExecutorChannelInterceptor;
import org.springframework.stereotype.Component;

import dev.converge.api.common.SpanExporter;
import dev.converge.api.common.TraceContext;

/**
 * Spans for the workspace channel (design §16.3): each message the API handles (a chat message, say) and
 * each subscription, named by destination with ids replaced. While a message is handled its trace is in the
 * logging context, like an HTTP request's, so every log line and outgoing call it causes carries it. A
 * client may continue its own trace by sending a traceparent header; otherwise each frame starts one.
 */
@Component
class StompSpans implements ExecutorChannelInterceptor {

    private record Open(String traceId, String spanId, String parentSpanId, long startNanos) {
    }

    private final ThreadLocal<Open> open = new ThreadLocal<>();

    @Override
    public Message<?> beforeHandle(Message<?> message, MessageChannel channel, MessageHandler handler) {
        if (!traced(message, handler)) return message;
        String header = StompHeaderAccessor.wrap(message).getFirstNativeHeader(TraceContext.HEADER);
        Open span = new Open(TraceContext.traceIdFrom(header), TraceContext.random(8), TraceContext.parentSpanFrom(header),
                System.currentTimeMillis() * 1_000_000L);
        open.set(span);
        MDC.put(TraceContext.MDC_KEY, span.traceId());
        MDC.put(TraceContext.SPAN_KEY, span.spanId());
        return message;
    }

    @Override
    public void afterMessageHandled(Message<?> message, MessageChannel channel, MessageHandler handler, Exception ex) {
        Open span = open.get();
        if (span == null || !traced(message, handler)) return;
        open.remove();
        MDC.remove(TraceContext.MDC_KEY);
        MDC.remove(TraceContext.SPAN_KEY);
        if (!SpanExporter.enabled()) return;
        StompHeaderAccessor stomp = StompHeaderAccessor.wrap(message);
        String destination = TraceContext.route(String.valueOf(stomp.getDestination()));
        Map<String, Object> attributes = new LinkedHashMap<>();
        attributes.put("messaging.system", "stomp");
        attributes.put("messaging.operation.name", stomp.getCommand().name());
        attributes.put("messaging.destination.name", destination);
        attributes.put("converge.connection_id", stomp.getSessionId());
        SpanExporter.record(new SpanExporter.Span(span.traceId(), span.spanId(), span.parentSpanId(),
                "STOMP " + stomp.getCommand().name() + " " + destination, SpanExporter.KIND_SERVER, span.startNanos(),
                System.currentTimeMillis() * 1_000_000L, ex != null, attributes));
    }

    /**
     * A SEND is handled by the controller method it is addressed to, a SUBSCRIBE by the broker. Other
     * handlers see the same frame too (the broker ignores application destinations), so only these count.
     */
    private static boolean traced(Message<?> message, MessageHandler handler) {
        StompCommand command = StompHeaderAccessor.wrap(message).getCommand();
        return command == StompCommand.SEND && handler instanceof SimpAnnotationMethodMessageHandler
                || command == StompCommand.SUBSCRIBE && handler instanceof AbstractBrokerMessageHandler;
    }
}
