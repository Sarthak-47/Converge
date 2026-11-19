-- Approvals and execution (design §11, §13.7, Phase 10; Gates C and E). An agent action beyond reading and
-- editing waits for a named approval that authorizes that exact action once; the executor re-checks the
-- approval before running the job in a sandbox.

create table approvals (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    session_id   uuid references sessions (id) on delete cascade,
    -- The agent turn that asked, or null when a member requested the job directly.
    turn_id      uuid references agent_turns (id) on delete cascade,
    requested_by uuid        not null references users (id),
    -- The canonical action (kind, workspace, command) and its SHA-256: the executor recomputes the hash
    -- from the job it is about to run, so an approved "npm test" cannot become something else.
    action       jsonb       not null,
    action_hash  text        not null,
    capabilities jsonb       not null,
    status       text        not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED')),
    decided_by   uuid references users (id),
    decided_at   timestamptz,
    row_version  integer     not null default 0,
    expires_at   timestamptz not null,
    -- Set by the executor in the same transaction that claims the job: an approval authorizes one run.
    used_at      timestamptz,
    created_at   timestamptz not null default now()
);
create index approvals_workspace_idx on approvals (workspace_id, created_at desc);
create index approvals_pending_idx on approvals (expires_at) where status = 'PENDING';

create table jobs (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    approval_id  uuid        not null unique references approvals (id),
    requested_by uuid        not null references users (id),
    kind         text        not null default 'run_command',
    command      text        not null,
    status       text        not null default 'QUEUED'
                     check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'OUTCOME_UNKNOWN')),
    exit_code    integer,
    error        text,
    container_ref text,
    heartbeat_at timestamptz,
    created_at   timestamptz not null default now(),
    started_at   timestamptz,
    ended_at     timestamptz,
    -- For OUTCOME_UNKNOWN jobs: the person who recorded what actually happened.
    outcome      text check (outcome in ('SUCCEEDED', 'FAILED')),
    outcome_by   uuid references users (id)
);
create index jobs_queue_idx on jobs (created_at) where status = 'QUEUED';

create table job_output (
    job_id     uuid        not null references jobs (id) on delete cascade,
    seq        integer     not null,
    stream     text        not null check (stream in ('stdout', 'stderr', 'system')),
    chunk      text        not null,
    created_at timestamptz not null default now(),
    primary key (job_id, seq)
);
