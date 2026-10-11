package dev.converge.api.chat;

import java.security.Principal;
import java.util.List;
import java.util.UUID;

import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageExceptionHandler;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.annotation.SendToUser;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.chat.ChatService.ChatMessage;
import dev.converge.api.common.ApiException;

@RestController
public class ChatController {

    public record SendChat(String body) {
    }

    public record RealtimeError(String message) {
    }

    private final ChatService chat;

    public ChatController(ChatService chat) {
        this.chat = chat;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/chat")
    List<ChatMessage> history(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId,
            @RequestParam(required = false) UUID before) {
        return chat.history(workspaceId, user.id(), before);
    }

    @MessageMapping("/workspace/{workspaceId}/chat")
    void send(@DestinationVariable UUID workspaceId, @Payload SendChat body, Principal principal) {
        chat.post(workspaceId, (AppUser) ((Authentication) principal).getPrincipal(), body.body());
    }

    /** Errors from STOMP handlers go back to the sender only (design §7.2: /user/queue/errors). */
    @MessageExceptionHandler(ApiException.class)
    @SendToUser(destinations = "/queue/errors", broadcast = false)
    RealtimeError onError(ApiException e) {
        return new RealtimeError(e.getMessage());
    }
}
