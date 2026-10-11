package dev.converge.api.realtime;

import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/** Forwards committed {@link WorkspaceEvent}s to subscribers of the workspace's events topic. */
@Component
public class WorkspaceEventPublisher {

    private final SimpMessagingTemplate messaging;

    public WorkspaceEventPublisher(SimpMessagingTemplate messaging) {
        this.messaging = messaging;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    void afterCommit(WorkspaceEvent event) {
        messaging.convertAndSend(event.topic(), event);
    }
}
