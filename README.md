# Converge

A real-time, multi-user development environment: a browser IDE with collaborative editing, presence, version history and (later) Git and isolated code execution.

The full design — architecture, protocols, roadmap and decision log — is in [docs/Converge_System_Design.docx](docs/Converge_System_Design.docx) (Revision 4).

**Status:** live collaborative editing, version history, a desktop app that keeps a local folder in two-way sync, and coding agents that work in the same live files as people (each turn paid with its sponsor's own API key, and revertible). See [docs/WORKLOG.md](docs/WORKLOG.md) for the decisions behind each step.

## Architecture at a glance

| Service | Path | Stack | Role |
|---|---|---|---|
| Web | `apps/web` | Vite + React + TypeScript | Browser client: Monaco bound to Yjs, file tree, chat |
| API | `apps/api` | Spring Boot 4.1, Java 21, Maven | Identity, workspaces, files, history, Git and job orchestration |
| Collab | `apps/collab` | Node 24 + Hocuspocus (Yjs) | Document synchronization: ticket auth, persistence, merging external changes |
| Agent runner | `apps/agent-runner` | Node 24 + Anthropic SDK | Agent turns on the Claude API; agents edit live documents as their own Yjs clients |
| nginx | `infra/nginx` | nginx | Single origin: `/` web, `/api` and `/ws` API, `/collab` collaboration socket; `/internal` is never routed |
| PostgreSQL 18, Redis 8 | `infra/compose.yaml` | | Durable state; transient fan-out and rate limits |

## Run the whole stack

Requires Docker Desktop.

```bash
docker compose up -d --build
```

Open http://localhost:8000 to see the health of every service. The API's aggregated health (database, Redis and the collaboration service) is at http://localhost:8000/api/actuator/health.

Default database credentials are development-only values from `.env.example`; copy it to `.env` to change them.

## Agents

Open a workspace, switch the right-hand panel to **Agents**, and save your own Anthropic API key. It is stored encrypted and only a hint is shown back. Every turn runs on the key of the member who prompts it.

To try agents without a key or any cost, start the stack with the scripted fake model:

```bash
COMPOSE_PROFILES=fake-model AGENT_MODEL_URL=http://fake-model:9100 docker compose up -d --build
```

Any key-shaped value then works (for example `sk-ant-test-0000000000000000`), and prompts drive the fake with directive lines such as `@tool read_file {"path":"app.ts"}`. See `apps/agent-runner/src/testing/fakeModel.ts` for the directives. Outside development, set `SECRETS_KEY` to your own value (`openssl rand -base64 32`).

## Develop a service locally

Run the infrastructure in Docker and the service you are working on natively:

```bash
docker compose up -d postgres redis
```

```bash
npm install
```

```bash
npm run dev:collab
```

```bash
cd apps/api && mvn spring-boot:run
```

```bash
npm run dev:web
```

The Vite dev server (http://localhost:5173) proxies `/api`, `/ws` and `/collab` the same way nginx does. The API needs JDK 21 or newer.

## Checks

```bash
npm run typecheck
```

```bash
cd apps/api && mvn test
```

```bash
npm test --workspace @converge/collab
```

End-to-end tests run against the full Compose stack (start it first):

```bash
npm run e2e
```

## Repository layout

```
apps/web        Vite + React client
apps/api        Spring Boot API
apps/collab     Hocuspocus collaboration service
infra/          Compose file and nginx config
docs/           Design document (ADRs will live in docs/adr)
```
