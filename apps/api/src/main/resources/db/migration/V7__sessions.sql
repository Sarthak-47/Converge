-- Coordination (design §13.3, §13.8, §13.9, Phase 9): sessions with lanes and watchers, a plan whose steps
-- belong to people, a current driver changed only by compare-and-set, and comments anchored to code.

create table sessions (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    task         text        not null check (length(task) between 1 and 2000),
    status       text        not null default 'ACTIVE' check (status in ('ACTIVE', 'AWAITING_TAKEOVER', 'DONE')),
    -- The member whose agent currently drives the session's plan, and pays for it. Changed only by takeover,
    -- handoff or completion, each a compare-and-set on row_version.
    driver_id    uuid        not null references users (id),
    created_by   uuid        not null references users (id),
    row_version  integer     not null default 0,
    created_at   timestamptz not null default now(),
    ended_at     timestamptz
);
create index sessions_workspace_idx on sessions (workspace_id, created_at desc);

create table session_participants (
    session_id uuid        not null references sessions (id) on delete cascade,
    user_id    uuid        not null references users (id) on delete cascade,
    mode       text        not null check (mode in ('LANE', 'WATCH')),
    joined_at  timestamptz not null default now(),
    primary key (session_id, user_id)
);

create table plan_steps (
    id          uuid primary key,
    session_id  uuid        not null references sessions (id) on delete cascade,
    position    integer     not null,
    title       text        not null check (length(title) between 1 and 300),
    owner_id    uuid references users (id),
    status      text        not null default 'TODO' check (status in ('TODO', 'IN_PROGRESS', 'DONE')),
    row_version integer     not null default 0,
    updated_at  timestamptz not null default now()
);
create index plan_steps_session_idx on plan_steps (session_id, position);

-- Turns now belong to a session; a lane is one participant's conversation with their own agent.
alter table agent_turns add column session_id uuid references sessions (id) on delete cascade;
drop index agent_turns_one_running_per_lane;
create unique index agent_turns_one_running_per_lane
    on agent_turns (workspace_id, coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid), lane_user_id)
    where status = 'RUNNING';

-- Comments anchor to a file range (Yjs relative positions, so they follow the text), a turn or a plan step.
-- Resolving never deletes.
create table comments (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    session_id   uuid references sessions (id) on delete cascade,
    target_kind  text        not null check (target_kind in ('FILE_RANGE', 'TURN', 'PLAN_STEP')),
    file_id      uuid references files (id) on delete cascade,
    turn_id      uuid references agent_turns (id) on delete cascade,
    step_id      uuid references plan_steps (id) on delete set null,
    anchor       jsonb,
    quote        text check (length(quote) <= 2000),
    body         text        not null check (length(body) between 1 and 4000),
    status       text        not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
    -- What the comment became, if anything: a plan step or an agent turn.
    caused_step_id uuid references plan_steps (id) on delete set null,
    caused_turn_id uuid references agent_turns (id) on delete set null,
    created_by   uuid        not null references users (id),
    created_at   timestamptz not null default now(),
    resolved_by  uuid references users (id),
    resolved_at  timestamptz,
    check ((target_kind = 'FILE_RANGE') = (file_id is not null and anchor is not null)),
    check ((target_kind = 'TURN') = (turn_id is not null))
);
create index comments_workspace_idx on comments (workspace_id, created_at);
