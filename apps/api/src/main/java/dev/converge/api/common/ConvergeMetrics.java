package dev.converge.api.common;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;

/**
 * Product metrics from design §16.1 and §16.4, on top of what Spring already measures (HTTP latency,
 * JVM, connection pools). Exposed on /api/actuator/prometheus to holders of the internal token.
 */
@Component
public class ConvergeMetrics {

    private final MeterRegistry registry;

    public ConvergeMetrics(MeterRegistry registry, JdbcClient jdbc) {
        this.registry = registry;
        // Queue depths are read on scrape; both queries hit partial indexes.
        Gauge.builder("job.queue.depth", () -> jdbc.sql("select count(*) from jobs where status = 'QUEUED'").query(Long.class).single())
                .description("Approved jobs waiting for the executor").register(registry);
        Gauge.builder("git.queue.depth", () -> jdbc.sql("select count(*) from git_operations where status = 'QUEUED'").query(Long.class).single())
                .description("Git operations waiting for the worker").register(registry);
        Gauge.builder("agent.turns.running", () -> jdbc.sql("select count(*) from agent_turns where status = 'RUNNING'").query(Long.class).single())
                .description("Agent turns in progress").register(registry);
    }

    /** agent_turns_total{status} and agent_turn_cost_micros{model}. */
    public void turnFinished(String status, String model, long costMicros) {
        Counter.builder("agent.turns").tag("status", status).description("Finished agent turns").register(registry).increment();
        DistributionSummary.builder("agent.turn.cost.micros").tag("model", model).description("Cost per agent turn")
                .publishPercentiles(0.5, 0.95).register(registry).record(costMicros);
    }

    /** agent_cache_hit_ratio: cache_read_input_tokens over all input tokens, per model response. */
    public void modelResponse(String model, long inputTokens, long cacheReadTokens, long cacheWriteTokens) {
        long total = inputTokens + cacheReadTokens + cacheWriteTokens;
        if (total == 0) return;
        DistributionSummary.builder("agent.cache.hit.ratio").tag("model", model == null ? "unknown" : model)
                .description("Share of input tokens served from the prompt cache").register(registry)
                .record((double) cacheReadTokens / total);
    }

    /** agent_tool_calls_total{tool,outcome}. */
    public void toolCall(String tool, boolean ok) {
        Counter.builder("agent.tool.calls").tag("tool", tool == null ? "unknown" : tool).tag("outcome", ok ? "ok" : "error")
                .description("Agent tool calls").register(registry).increment();
    }

    public void approvalDecided(String decision) {
        Counter.builder("approvals.decided").tag("decision", decision).description("Approval cards answered").register(registry).increment();
    }

    /** job_duration_ms{status}. */
    public void jobFinished(String status, long durationMs) {
        Timer.builder("job.duration").tag("status", status).description("Sandbox job duration")
                .publishPercentiles(0.5, 0.95).register(registry).record(java.time.Duration.ofMillis(Math.max(0, durationMs)));
    }

    public void rateLimited(String bucket) {
        Counter.builder("rate.limited").tag("bucket", bucket).description("Requests refused by a rate limit").register(registry).increment();
    }
}
