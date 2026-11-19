-- Agents as collaborators (design §13, Phase 8): members' own API keys, agent turns with exactly one sponsor
-- each (the cost ledger), their transcripts, and what each turn changed so it can be reverted.

-- A member's own provider key, encrypted with the server's secrets key; never sent to any client.
create table provider_keys (
    user_id    uuid        not null references users (id) on delete cascade,
    provider   text        not null check (provider in ('ANTHROPIC')),
    ciphertext bytea       not null,
    key_hint   text        not null,
    created_at timestamptz not null default now(),
    primary key (user_id, provider)
);

create table agent_turns (
    id                 uuid primary key,
    workspace_id       uuid        not null references workspaces (id) on delete cascade,
    -- The lane the turn belongs to. Sessions (Phase 9) will group lanes; until then a lane is per member.
    lane_user_id       uuid        not null references users (id),
    sponsor_id         uuid        not null references users (id),
    model              text        not null,
    status             text        not null check (status in
                           ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUSED', 'BUDGET_EXCEEDED')),
    error              text,
    input_tokens       bigint      not null default 0,
    output_tokens      bigint      not null default 0,
    cache_read_tokens  bigint      not null default 0,
    cache_write_tokens bigint      not null default 0,
    cost_micros        bigint      not null default 0,
    cost_cap_micros    bigint      not null,
    started_at         timestamptz not null default now(),
    ended_at           timestamptz,
    revert_status      text check (revert_status in ('REVERTING', 'REVERTED')),
    reverted_by        uuid references users (id),
    reverted_at        timestamptz
);
create index agent_turns_workspace_idx on agent_turns (workspace_id, started_at desc);
-- At most one running turn per lane.
create unique index agent_turns_one_running_per_lane on agent_turns (workspace_id, lane_user_id) where status = 'RUNNING';

-- The lane transcript: prompts, replies, progress notes and tool summaries, encrypted at rest.
create table transcript_chunks (
    turn_id    uuid        not null references agent_turns (id) on delete cascade,
    seq        integer     not null,
    kind       text        not null,
    ciphertext bytea       not null,
    created_at timestamptz not null default now(),
    primary key (turn_id, seq)
);

-- Per file a turn changed: the agent's replica at the end of the turn (it still holds the text the agent
-- deleted) and the Yjs ID ranges it inserted and deleted. Enough to revert the turn at any later time.
create table agent_turn_files (
    turn_id   uuid  not null references agent_turns (id) on delete cascade,
    file_id   uuid  not null references files (id) on delete cascade,
    doc_state bytea not null,
    undo      jsonb not null,
    primary key (turn_id, file_id)
);
