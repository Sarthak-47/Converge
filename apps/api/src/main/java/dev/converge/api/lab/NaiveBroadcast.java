package dev.converge.api.lab;

import java.security.Principal;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

/**
 * LAB, deliberately broken (design §8.1, Phase 2). Each client sends the whole document after every edit and
 * the server keeps the last one it received. Two people typing at once therefore overwrite each other.
 * {@code NaiveBroadcastTest} reproduces the lost edit; Phase 3 replaces this with Yjs, and this class stays
 * only as the recorded "before" of that engineering story.
 */
@Controller
public class NaiveBroadcast {

    public record WholeDocument(String clientId, String text) {
    }

    private final Map<UUID, String> lastWriteWins = new ConcurrentHashMap<>();
    private final SimpMessagingTemplate messaging;

    public NaiveBroadcast(SimpMessagingTemplate messaging) {
        this.messaging = messaging;
    }

    @MessageMapping("/file/{fileId}/naive")
    void receive(@DestinationVariable UUID fileId, @Payload WholeDocument update, Principal principal) {
        lastWriteWins.put(fileId, update.text());
        messaging.convertAndSend("/topic/file/" + fileId + "/naive", update);
    }

    public String current(UUID fileId) {
        return lastWriteWins.get(fileId);
    }
}
