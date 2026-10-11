-- Workspace chat (FR-09). Messages are durable; delivery to connected clients is over STOMP.
create table chat_messages (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    user_id      uuid        not null references users (id),
    body         text        not null check (length(body) between 1 and 4000),
    created_at   timestamptz not null default now()
);
create index chat_messages_workspace_time_idx on chat_messages (workspace_id, created_at desc, id desc);
