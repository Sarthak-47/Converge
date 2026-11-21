package dev.converge.api.common;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Turns span export on at startup when an OTLP endpoint is configured, and flushes it on shutdown. */
@Component
class TracingConfig implements DisposableBean {

    private final SpanExporter exporter;

    TracingConfig(@Value("${converge.tracing.otlp-endpoint:}") String endpoint,
            @Value("${converge.tracing.service-name:converge-api}") String serviceName) {
        this.exporter = endpoint.isBlank() ? null : SpanExporter.start(endpoint.strip(), serviceName, 2000);
    }

    @Override
    public void destroy() {
        if (exporter != null) exporter.stop();
    }
}
