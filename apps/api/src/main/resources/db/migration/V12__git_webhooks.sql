-- GitHub push webhooks (design §10.2, "Webhook"): a per-repository secret, encrypted at rest like the token, that
-- signs deliveries. Null means automatic import is off.
alter table git_repositories
    add column webhook_secret bytea,
    add column webhook_enabled_at timestamptz;
