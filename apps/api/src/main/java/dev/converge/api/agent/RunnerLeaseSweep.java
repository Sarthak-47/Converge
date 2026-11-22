package dev.converge.api.agent;

import java.util.List;
import java.util.UUID;
import java.util.function.Predicate;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Ends turns whose agent runner died (design §7.5). Each runner keeps a lease in Redis on every turn it
 * runs, renewed every 10 seconds and expiring after 30. A turn still RUNNING a minute after it started, with
 * no lease, has no runner left: it is ended as failed, so its lane and session do not wait forever. Safe on
 * several API instances at once, since a turn ends only while it is still running.
 *
 * Off unless the runners keep leases (AGENT_RUNNER_LEASES=true, set in the Compose stack), because a runner
 * without Redis keeps none.
 */
@Component
class RunnerLeaseSweep {

    private static final Logger log = LoggerFactory.getLogger(RunnerLeaseSweep.class);
    static final String STOPPED = "The agent runner stopped while working on this turn; send the prompt again";

    private final JdbcClient jdbc;
    private final AgentTurns turns;
    private final ObjectProvider<StringRedisTemplate> redis;
    private final boolean enabled;

    RunnerLeaseSweep(JdbcClient jdbc, AgentTurns turns, ObjectProvider<StringRedisTemplate> redis,
            @Value("${converge.agent.runner-leases:false}") boolean enabled) {
        this.jdbc = jdbc;
        this.turns = turns;
        this.redis = redis;
        this.enabled = enabled;
    }

    @Scheduled(fixedDelay = 30_000, initialDelay = 30_000)
    void scheduled() {
        if (!enabled) return;
        StringRedisTemplate template = redis.getIfAvailable();
        if (template == null) return;
        try {
            sweep(turnId -> Boolean.TRUE.equals(template.hasKey("converge:runner-lease:" + turnId)));
        } catch (RuntimeException e) {
            // Redis unreachable: a missing answer is not a missing lease, so nothing is ended.
            log.warn("Could not check agent runner leases: {}", e.getMessage());
        }
    }

    /** Ends running turns older than a minute that have no lease; returns how many. */
    int sweep(Predicate<UUID> leased) {
        List<UUID> candidates = jdbc.sql("""
                select id from agent_turns where status = 'RUNNING' and started_at < now() - interval '1 minute'
                """).query(UUID.class).list();
        int ended = 0;
        for (UUID turnId : candidates) {
            if (leased.test(turnId)) continue;
            log.warn("Agent turn {} has no runner lease; ending it", turnId);
            turns.finish(turnId, "FAILED", STOPPED);
            ended++;
        }
        return ended;
    }
}
