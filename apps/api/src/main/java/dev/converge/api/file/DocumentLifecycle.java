package dev.converge.api.file;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import dev.converge.api.file.FileService.FilesDeleted;
import dev.converge.api.realtime.CollabClient;

/** Closes live documents of deleted files once the delete has committed (design §8.10). */
@Component
class DocumentLifecycle {

    private static final Logger log = LoggerFactory.getLogger(DocumentLifecycle.class);

    private final CollabClient collab;

    DocumentLifecycle(CollabClient collab) {
        this.collab = collab;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    void onFilesDeleted(FilesDeleted deleted) {
        for (UUID fileId : deleted.fileIds()) {
            try {
                collab.close(fileId);
            } catch (RuntimeException e) {
                // Clients are also told through the FILE_DELETED event, and tickets for deleted files are refused.
                log.warn("Could not close the live document of deleted file {}", fileId, e);
            }
        }
    }
}
