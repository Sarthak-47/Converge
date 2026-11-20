-- Git integration (design §10, Phase 12). The Git working tree is a projection of the live documents, written
-- out by the worker at commit time; it is never edited in place while the workspace is live.

create table git_repositories (
    workspace_id   uuid primary key references workspaces (id) on delete cascade,
    remote_url     text        not null check (length(remote_url) <= 500),
    default_branch text        not null default 'main' check (length(default_branch) between 1 and 100),
    -- GitHub owner/repo, parsed from the remote, for opening pull requests.
    owner          text        not null,
    repo           text        not null,
    -- A token that may push branches and open pull requests, encrypted at rest; never sent to a browser.
    credential     bytea       not null,
    credential_hint text       not null,
    connected_by   uuid        not null references users (id),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create table git_operations (
    id              uuid primary key,
    workspace_id    uuid        not null references workspaces (id) on delete cascade,
    session_id      uuid references sessions (id) on delete set null,
    requested_by    uuid        not null references users (id),
    type            text        not null check (type in ('PULL_REQUEST', 'PUSH_BRANCH')),
    status          text        not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    -- Client-chosen, so a retried request never starts a second push (design §15.3).
    idempotency_key text        not null,
    params          jsonb       not null,
    result          jsonb,
    error           text,
    log             text,
    created_at      timestamptz not null default now(),
    started_at      timestamptz,
    ended_at        timestamptz,
    unique (workspace_id, idempotency_key)
);
create index git_operations_queue_idx on git_operations (created_at) where status = 'QUEUED';
create index git_operations_workspace_idx on git_operations (workspace_id, created_at desc);
