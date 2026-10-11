-- Phase 1 core schema: identity, workspaces, membership, file tree and document text.
-- Document text lives here only until Phase 3, when Yjs state becomes the source of truth (design §6.4).

create table users (
    id            uuid primary key,
    email         text        not null check (length(email) between 3 and 320),
    display_name  text        not null check (length(display_name) between 1 and 80),
    password_hash text        not null,
    created_at    timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table workspaces (
    id         uuid primary key,
    owner_id   uuid        not null references users (id),
    name       text        not null check (length(name) between 1 and 100),
    slug       text        not null,
    status     text        not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
    created_at timestamptz not null default now(),
    unique (owner_id, slug)
);

create table workspace_members (
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    user_id      uuid        not null references users (id) on delete cascade,
    role         text        not null check (role in ('OWNER', 'EDITOR', 'COMMENTER', 'VIEWER')),
    joined_at    timestamptz not null default now(),
    primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on workspace_members (user_id);

create table files (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    parent_id    uuid references files (id),
    name         text        not null check (length(name) between 1 and 255),
    kind         text        not null check (kind in ('FILE', 'FOLDER')),
    path         text        not null,
    language     text,
    row_version  integer     not null default 0,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    deleted_at   timestamptz
);
-- One live file per path; deleted files keep their path for restore and history.
create unique index files_live_path_key on files (workspace_id, path) where deleted_at is null;
create index files_parent_idx on files (parent_id);

create table documents (
    file_id         uuid primary key references files (id) on delete cascade,
    text_content    text        not null default '',
    content_hash    text        not null,
    content_version integer     not null default 0,
    updated_at      timestamptz not null default now()
);
