package dev.converge.api.common;

import java.time.Duration;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

/**
 * Sliding-window rate limits in Redis (design §14), shared by every API instance. Each check is one atomic
 * script that counts the request in the current window and reads the previous one; the estimate weights the
 * previous window by how much of it still overlaps the last {@code window}. Unlike fixed windows, a burst at
 * a window boundary cannot get twice the limit through. When Redis is
 * unavailable the limit is skipped and logged: availability wins over throttling, and the database-backed
 * rules (single-use tickets, approvals, compare-and-set) still hold.
 */
@Component
public class RateLimiter {

    /** A named limit: at most {@code max} requests per {@code window} for one subject. */
    public record Limit(String bucket, int max, Duration window) {
    }

    private static final Logger log = LoggerFactory.getLogger(RateLimiter.class);
    @SuppressWarnings("rawtypes")
    private static final DefaultRedisScript<List> COUNT = new DefaultRedisScript<>("""
            local current = redis.call('INCR', KEYS[1])
            if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
            local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
            return {current, previous}
            """, List.class);

    private final StringRedisTemplate redis;
    private final ConvergeMetrics metrics;
    private final double scale;

    public RateLimiter(StringRedisTemplate redis, ConvergeMetrics metrics,
            @Value("${converge.rate-limits.scale:1.0}") double scale) {
        this.redis = redis;
        this.metrics = metrics;
        this.scale = scale;
    }

    /** Counts a request; throws {@link RateLimitedException} once the subject is over the limit. */
    public void check(Limit limit, String subject) {
        if (scale <= 0) return;
        long windowMs = limit.window().toMillis();
        long now = System.currentTimeMillis();
        long window = now / windowMs;
        String prefix = "rl:" + limit.bucket() + ":" + subject + ":";
        List<?> counts;
        try {
            // Kept for two windows, so the next window can still read this one as its previous.
            counts = redis.execute(COUNT, List.of(prefix + window, prefix + (window - 1)), String.valueOf(windowMs * 2));
        } catch (RuntimeException e) {
            log.warn("Rate limit {} skipped: Redis unavailable ({})", limit.bucket(), e.getMessage());
            return;
        }
        if (counts == null || counts.size() < 2) return;
        long current = ((Number) counts.get(0)).longValue();
        long previous = ((Number) counts.get(1)).longValue();
        double overlap = 1.0 - (double) (now % windowMs) / windowMs;
        double estimate = previous * overlap + current;
        int max = (int) Math.max(1, Math.round(limit.max() * scale));
        if (estimate > max) {
            metrics.rateLimited(limit.bucket());
            long retryAfterMs = (window + 1) * windowMs - now;
            throw new RateLimitedException(Math.max(1, (retryAfterMs + 999) / 1000));
        }
    }

    // ---- The limits (per subject) -----------------------------------------------------------------------

    /** Sign-in attempts per email and per client address: slows password guessing. */
    public static final Limit LOGIN = new Limit("login", 10, Duration.ofMinutes(5));
    public static final Limit REGISTER = new Limit("register", 20, Duration.ofHours(1));
    /** Agent prompts per member: each spends their key, so a runaway client cannot drain it. */
    public static final Limit AGENT_PROMPT = new Limit("agent-prompt", 30, Duration.ofMinutes(10));
    /** Approval cards an agent turn may raise. */
    public static final Limit AGENT_ACTION = new Limit("agent-action", 20, Duration.ofMinutes(10));
    /** Sandbox jobs a member may start directly. */
    public static final Limit JOB = new Limit("job", 20, Duration.ofMinutes(10));
    /** Pushes and pull requests per workspace. */
    public static final Limit GIT = new Limit("git", 20, Duration.ofMinutes(10));
    /** Comments and notes per member. */
    public static final Limit WRITE = new Limit("write", 120, Duration.ofMinutes(1));
}
