package dev.converge.api.file;

import java.time.Duration;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Deleting a file only marks it, so it can be restored from "Recently deleted" for 30 days. After that it
 * is removed for good, with its text, versions, memory notes and everything else that hangs off it (those
 * tables cascade). A folder goes only once nothing still kept is inside it. Safe to run on several API
 * instances at once: each row is deleted by whichever gets there first.
 */
@Component
class DeletedFilePurge {

    private static final Logger log = LoggerFactory.getLogger(DeletedFilePurge.class);
    private static final int BATCH = 500;

    private final JdbcClient jdbc;
    private final Duration keepFor;

    DeletedFilePurge(JdbcClient jdbc, @Value("${converge.files.keep-deleted:30d}") Duration keepFor) {
        this.jdbc = jdbc;
        this.keepFor = keepFor;
    }

    @Scheduled(fixedDelay = 60 * 60 * 1000, initialDelay = 5 * 60 * 1000)
    void scheduled() {
        purge();
    }

    /** Removes files deleted longer ago than the keep period; returns how many rows went. */
    int purge() {
        int total = 0;
        int removed;
        do {
            removed = jdbc.sql("""
                    delete from files where id in (
                        select f.id from files f
                        where f.deleted_at < now() - make_interval(secs => ?)
                          and not exists (select 1 from files c where c.parent_id = f.id
                                          and (c.deleted_at is null or c.deleted_at >= now() - make_interval(secs => ?)))
                        limit ?)
                    """)
                    .params(keepFor.toSeconds(), keepFor.toSeconds(), BATCH)
                    .update();
            total += removed;
        } while (removed > 0);
        if (total > 0) log.info("Purged {} files deleted more than {} days ago", total, keepFor.toDays());
        return total;
    }
}
