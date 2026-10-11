-- Phase 6: plaintext versions of each file (design §9.2, §9.4). Yjs garbage collection stays on, so history
-- is kept as text rather than Yjs snapshots; restores go back in through the external-change path.
create table snapshots (
    id           uuid primary key,
    file_id      uuid        not null references files (id) on delete cascade,
    version_no   integer     not null,
    text_content text        not null,
    content_hash text        not null,
    reason       text        not null check (reason in ('MANUAL', 'AUTO', 'PRE_EXTERNAL')),
    label        text        check (length(label) <= 120),
    created_by   uuid references users (id),
    created_at   timestamptz not null default now(),
    unique (file_id, version_no)
);
create index snapshots_file_time_idx on snapshots (file_id, created_at desc);
