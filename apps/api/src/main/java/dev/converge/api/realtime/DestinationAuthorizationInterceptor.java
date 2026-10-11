package dev.converge.api.realtime;

import java.security.Principal;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;

import dev.converge.api.auth.AppUser;
import dev.converge.api.common.ApiException;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * Authorizes every SUBSCRIBE and SEND against workspace membership. The destination alone is never trusted
 * (design §14.3): a client that subscribes to another workspace's topic is rejected here.
 */
@Component
public class DestinationAuthorizationInterceptor implements ChannelInterceptor {

    private record Rule(StompCommand command, Pattern pattern, Role minimum, boolean fileScoped) {
    }

    private static final String UUID_RE = "([0-9a-fA-F-]{36})";

    private static final Rule[] RULES = {
            new Rule(StompCommand.SUBSCRIBE, Pattern.compile("^/topic/workspace/" + UUID_RE + "/(chat|events|presence)$"), Role.VIEWER, false),
            new Rule(StompCommand.SUBSCRIBE, Pattern.compile("^/app/workspace/" + UUID_RE + "/presence$"), Role.VIEWER, false),
            new Rule(StompCommand.SEND, Pattern.compile("^/app/workspace/" + UUID_RE + "/chat$"), Role.COMMENTER, false),
            new Rule(StompCommand.SUBSCRIBE, Pattern.compile("^/topic/file/" + UUID_RE + "/naive$"), Role.VIEWER, true),
            new Rule(StompCommand.SEND, Pattern.compile("^/app/file/" + UUID_RE + "/naive$"), Role.EDITOR, true),
    };

    private static final Pattern PRESENCE_TOPIC = Pattern.compile("^/topic/workspace/" + UUID_RE + "/presence$");

    private final WorkspaceAccess access;
    private final JdbcClient jdbc;
    private final PresenceTracker presence;

    public DestinationAuthorizationInterceptor(WorkspaceAccess access, JdbcClient jdbc, PresenceTracker presence) {
        this.access = access;
        this.jdbc = jdbc;
        this.presence = presence;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor stomp = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (stomp == null || stomp.getCommand() == null) {
            return message;
        }
        StompCommand command = stomp.getCommand();
        if (command != StompCommand.SUBSCRIBE && command != StompCommand.SEND) {
            return message;
        }
        AppUser user = userOf(stomp.getUser());
        String destination = stomp.getDestination() == null ? "" : stomp.getDestination();
        if (command == StompCommand.SUBSCRIBE && destination.startsWith("/user/queue/")) {
            return message; // user destinations are delivered only to their owner by Spring
        }
        for (Rule rule : RULES) {
            Matcher m = rule.pattern().matcher(destination);
            if (rule.command() == command && m.matches()) {
                UUID id = UUID.fromString(m.group(1));
                UUID workspaceId = rule.fileScoped() ? workspaceOfFile(id) : id;
                try {
                    access.require(workspaceId, user.id(), rule.minimum());
                } catch (ApiException e) {
                    throw new AccessDeniedException(e.getMessage());
                }
                if (command == StompCommand.SUBSCRIBE && PRESENCE_TOPIC.matcher(destination).matches()) {
                    // Recorded only now, after authorization, so a rejected subscriber never shows as online.
                    presence.join(workspaceId, stomp.getSessionId(), stomp.getSubscriptionId(), user);
                }
                return message;
            }
        }
        throw new AccessDeniedException("Unknown destination");
    }

    private UUID workspaceOfFile(UUID fileId) {
        return jdbc.sql("select workspace_id from files where id = ? and deleted_at is null")
                .param(fileId)
                .query(UUID.class)
                .optional()
                .orElseThrow(() -> new AccessDeniedException("File not found"));
    }

    static AppUser userOf(Principal principal) {
        if (principal instanceof Authentication auth && auth.getPrincipal() instanceof AppUser user) {
            return user;
        }
        throw new AccessDeniedException("Not signed in");
    }
}
