package dev.converge.api.realtime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import dev.converge.api.common.ApiException;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * Tickets let a browser open a collaboration connection without putting its session cookie or a long-lived
 * token in the WebSocket URL (design §14.4). A ticket is bound to one user and one file, valid for 60 seconds
 * and usable once; membership is checked again when it is redeemed.
 */
@Service
public class TicketService {

    public record Ticket(String ticket, Instant expiresAt) {
    }

    /** What the collaboration service learns about a redeemed connection. */
    public record Grant(UUID userId, String displayName, UUID fileId, UUID workspaceId, Role role, boolean readOnly) {
    }

    static final Duration TTL = Duration.ofSeconds(60);

    private final SecureRandom random = new SecureRandom();
    private final JdbcClient jdbc;
    private final WorkspaceAccess access;

    public TicketService(JdbcClient jdbc, WorkspaceAccess access) {
        this.jdbc = jdbc;
        this.access = access;
    }

    public Ticket issue(UUID fileId, UUID userId) {
        access.require(workspaceOf(fileId), userId, Role.VIEWER);
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        Instant expiresAt = Instant.now().plus(TTL);
        jdbc.sql("insert into realtime_tickets (token_hash, user_id, file_id, expires_at) values (?, ?, ?, ?)")
                .params(hash(ticket), userId, fileId, java.sql.Timestamp.from(expiresAt))
                .update();
        return new Ticket(ticket, expiresAt);
    }

    /** Marks the ticket used and returns the grant; any second use, expiry or mismatch is refused. */
    public Grant redeem(String ticket, UUID documentFileId) {
        record Claim(UUID userId, UUID fileId) {
        }
        Claim claim = jdbc.sql("""
                update realtime_tickets set used_at = now()
                where token_hash = ? and used_at is null and expires_at > now()
                returning user_id, file_id
                """)
                .param(hash(ticket == null ? "" : ticket))
                .query((rs, n) -> new Claim(rs.getObject("user_id", UUID.class), rs.getObject("file_id", UUID.class)))
                .optional()
                .orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "Ticket missing, expired or already used"));
        if (!claim.fileId().equals(documentFileId)) {
            throw ApiException.forbidden("Ticket was issued for a different file");
        }
        UUID workspaceId = workspaceOf(claim.fileId());
        Role role;
        try {
            role = access.require(workspaceId, claim.userId(), Role.VIEWER);
        } catch (ApiException e) {
            throw ApiException.forbidden("No longer a member of this workspace");
        }
        String displayName = jdbc.sql("select display_name from users where id = ?").param(claim.userId())
                .query(String.class).single();
        return new Grant(claim.userId(), displayName, claim.fileId(), workspaceId, role, !role.atLeast(Role.EDITOR));
    }

    @Scheduled(fixedDelay = 10 * 60 * 1000)
    void deleteExpired() {
        jdbc.sql("delete from realtime_tickets where expires_at < now() - interval '1 hour'").update();
    }

    private UUID workspaceOf(UUID fileId) {
        return jdbc.sql("select workspace_id from files where id = ? and deleted_at is null and kind = 'FILE'")
                .param(fileId)
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("File"));
    }

    static String hash(String ticket) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(ticket.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
