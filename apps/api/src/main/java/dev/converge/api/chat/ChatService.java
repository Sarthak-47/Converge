package dev.converge.api.chat;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

import dev.converge.api.auth.AppUser;
import dev.converge.api.common.ApiException;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

@Service
public class ChatService {

    public record ChatMessage(UUID id, UUID workspaceId, UUID userId, String displayName, String body, Instant createdAt) {
    }

    public static final int MAX_BODY = 4000;
    private static final int PAGE = 50;

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;
    private final SimpMessagingTemplate messaging;

    public ChatService(JdbcClient jdbc, WorkspaceAccess access, SimpMessagingTemplate messaging) {
        this.jdbc = jdbc;
        this.access = access;
        this.messaging = messaging;
    }

    /** Persists the message first, then broadcasts it, so every delivered message is also in history. */
    public ChatMessage post(UUID workspaceId, AppUser author, String rawBody) {
        access.require(workspaceId, author.id(), Role.COMMENTER);
        String body = rawBody == null ? "" : rawBody.strip();
        if (body.isEmpty() || body.length() > MAX_BODY) {
            throw ApiException.badRequest("Messages must be 1 to " + MAX_BODY + " characters");
        }
        UUID id = UUID.randomUUID();
        Instant createdAt = jdbc.sql("insert into chat_messages (id, workspace_id, user_id, body) values (?, ?, ?, ?) returning created_at")
                .params(id, workspaceId, author.id(), body)
                .query(OffsetDateTime.class)
                .single()
                .toInstant();
        ChatMessage message = new ChatMessage(id, workspaceId, author.id(), author.displayName(), body, createdAt);
        messaging.convertAndSend("/topic/workspace/" + workspaceId + "/chat", message);
        return message;
    }

    /** Newest-first page of history, optionally older than a message id (keyset pagination). */
    public List<ChatMessage> history(UUID workspaceId, UUID userId, UUID before) {
        access.require(workspaceId, userId, Role.VIEWER);
        String sql = """
                select c.id, c.workspace_id, c.user_id, u.display_name, c.body, c.created_at
                from chat_messages c join users u on u.id = c.user_id
                where c.workspace_id = ?
                """ + (before == null ? "" : """
                  and (c.created_at, c.id) < (select created_at, id from chat_messages where id = ? and workspace_id = ?)
                """) + " order by c.created_at desc, c.id desc limit " + PAGE;
        var query = jdbc.sql(sql).param(workspaceId);
        if (before != null) {
            query = query.param(before).param(workspaceId);
        }
        return query.query((rs, n) -> new ChatMessage(rs.getObject("id", UUID.class), rs.getObject("workspace_id", UUID.class),
                        rs.getObject("user_id", UUID.class), rs.getString("display_name"), rs.getString("body"),
                        rs.getObject("created_at", OffsetDateTime.class).toInstant()))
                .list();
    }
}
