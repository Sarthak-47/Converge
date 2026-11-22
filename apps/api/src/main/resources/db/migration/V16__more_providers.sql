-- Members may bring a key for OpenAI, Google Gemini or OpenRouter as well as Anthropic; each is stored the
-- same way, encrypted, one per provider.
alter table provider_keys drop constraint provider_keys_provider_check;
alter table provider_keys add constraint provider_keys_provider_check
    check (provider in ('ANTHROPIC', 'OPENAI', 'GEMINI', 'OPENROUTER'));
