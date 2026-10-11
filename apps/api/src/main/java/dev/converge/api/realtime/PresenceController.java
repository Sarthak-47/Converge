package dev.converge.api.realtime;

import java.util.List;
import java.util.UUID;

import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.simp.annotation.SubscribeMapping;
import org.springframework.stereotype.Controller;

import dev.converge.api.realtime.PresenceTracker.OnlineUser;

@Controller
public class PresenceController {

    private final PresenceTracker presence;

    public PresenceController(PresenceTracker presence) {
        this.presence = presence;
    }

    /**
     * Replies once, directly to the subscriber, with who is online now. Updates then arrive on the presence
     * topic; together they avoid missing the broadcast sent while the subscription was being set up.
     */
    @SubscribeMapping("/workspace/{workspaceId}/presence")
    List<OnlineUser> snapshot(@DestinationVariable UUID workspaceId) {
        return presence.online(workspaceId);
    }
}
