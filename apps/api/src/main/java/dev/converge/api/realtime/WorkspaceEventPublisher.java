package dev.converge.api.realtime;

import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Forwards committed {@link WorkspaceEvent}s to subscribers of the workspace's events topic. Events raised
 * outside a transaction (scheduled jobs, listeners that run after another commit, single-statement updates) are
 * sent at once; without the fallback they would be silently dropped.
 */
@Component
public class WorkspaceEventPublisher {

    private final ClusterBus bus;

    public WorkspaceEventPublisher(ClusterBus bus) {
        this.bus = bus;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    void afterCommit(WorkspaceEvent event) {
        bus.send(event.topic(), event);
    }
}
