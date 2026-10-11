-- Phase 5: inviting people by email, and an audit trail of security-sensitive actions (FR-03, FR-15).

-- People invited before they have an account. Accepted automatically when someone registers or signs in
-- with that email, so no email delivery is needed yet.
create table workspace_invitations (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    email        text        not null,
    role         text        not null check (role in ('OWNER', 'EDITOR', 'COMMENTER', 'VIEWER')),
    invited_by   uuid        not null references users (id),
    created_at   timestamptz not null default now()
);
create unique index workspace_invitations_email_key on workspace_invitations (workspace_id, lower(email));
create index workspace_invitations_lookup_idx on workspace_invitations (lower(email));

create table audit_events (
    id           uuid primary key,
    workspace_id uuid        not null references workspaces (id) on delete cascade,
    actor_id     uuid        not null references users (id),
    action       text        not null,
    entity_type  text        not null,
    entity_id    text,
    metadata     jsonb       not null default '{}'::jsonb,
    created_at   timestamptz not null default now()
);
create index audit_events_workspace_time_idx on audit_events (workspace_id, created_at desc);
