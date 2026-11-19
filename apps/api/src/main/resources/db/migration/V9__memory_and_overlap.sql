-- Workspace memory, overlap warnings and advisory range locks (design §13.10, §13.11, Phase 11).

-- Short notes pinned to code. The anchor is a pair of Yjs relative positions, so the note follows its code
-- through every edit; the collaboration service compares the anchored text with what the note was written
-- about and flags the note STALE when that code is deleted or rewritten.
create table memories (
    id              uuid primary key,
    workspace_id    uuid        not null references workspaces (id) on delete cascade,
    file_id         uuid        not null references files (id) on delete cascade,
    kind            text        not null check (kind in ('DECISION', 'GOTCHA', 'CONVENTION', 'NOTE')),
    body            text        not null check (length(body) between 1 and 2000),
    anchor          jsonb       not null,
    -- The code the note was written about, its hash, and what the anchor covers now.
    anchored_text   text        not null check (length(anchored_text) between 1 and 4000),
    anchor_hash     text        not null,
    current_text    text,
    similarity      real,
    status          text        not null default 'ACTIVE' check (status in ('ACTIVE', 'STALE', 'RETIRED')),
    created_by      uuid        not null references users (id),
    -- Set when an agent wrote the note during a turn.
    created_in_turn uuid references agent_turns (id) on delete set null,
    updated_by      uuid references users (id),
    row_version     integer     not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    checked_at      timestamptz
);
create index memories_file_idx on memories (file_id) where status <> 'RETIRED';
create index memories_workspace_idx on memories (workspace_id, updated_at desc);

-- A person holds an exact range for a while; connected agents are told to stay out of it. Advisory: the CRDT
-- already prevents lost edits; this prevents wasted or conflicting work.
create table range_locks (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    file_id      uuid        not null references files (id) on delete cascade,
    anchor       jsonb       not null,
    quote        text        not null check (length(quote) <= 4000),
    reason       text        not null check (length(reason) between 1 and 300),
    holder_id    uuid        not null references users (id),
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    released_at  timestamptz
);
create index range_locks_file_idx on range_locks (file_id) where released_at is null;

-- Files an agent opened during a turn, recorded as it opens them, so overlap checks see work in progress.
create table agent_turn_touches (
    turn_id    uuid        not null references agent_turns (id) on delete cascade,
    file_id    uuid        not null references files (id) on delete cascade,
    touched_at timestamptz not null default now(),
    primary key (turn_id, file_id)
);
create index agent_turn_touches_file_idx on agent_turn_touches (file_id, touched_at desc);
