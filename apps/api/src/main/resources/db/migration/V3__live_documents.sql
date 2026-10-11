-- Phase 3: the Yjs document becomes the only owner of live content (design §6.4).
-- text_content stays as the materialized projection, written by the collaboration service on every store.
alter table documents
    add column yjs_state        bytea,
    add column state_updated_at timestamptz;

-- Single-use, short-lived tickets for opening a collaboration connection (design §14.4).
-- Only a hash is stored, so a database leak does not reveal usable tickets.
create table realtime_tickets (
    token_hash text primary key,
    user_id    uuid        not null references users (id) on delete cascade,
    file_id    uuid        not null references files (id) on delete cascade,
    expires_at timestamptz not null,
    used_at    timestamptz,
    created_at timestamptz not null default now()
);
create index realtime_tickets_expiry_idx on realtime_tickets (expires_at);
