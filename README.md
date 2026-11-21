# Converge

A real-time, multi-user development environment where a team and its coding agents edit, test and ship code together: a browser IDE and a desktop app with live local sync, collaborative editing, version history, agents that type in the same files as people, sandboxed test runs behind approvals, and pull requests from sessions.

The full design — architecture, protocols, roadmap and decision log — is in [docs/Converge_System_Design.docx](docs/Converge_System_Design.docx) (Revision 4).

**Status:** every functional requirement in the design (§3.1) is built and tested, along with the stretch goals: agents, sessions, approvals, workspace memory, Git (including import and push webhooks) and the desktop app with live local sync. See [docs/WORKLOG.md](docs/WORKLOG.md) for the decisions behind each step and [docs/BASELINE.md](docs/BASELINE.md) for measured latency, load and fault recovery.

**Known limits:**
- Desktop builds are unsigned, because signing needs paid code-signing certificates.
- The API runs as one instance. Sign-ins, rate limits and data are shared through PostgreSQL and Redis, but the workspace channel (chat, presence, live events) uses an in-memory broker, so a second instance would need a STOMP broker relay or Redis fan-out (design §7.5).

## Architecture at a glance

| Service | Path | Stack | Role |
|---|---|---|---|
| Web | `apps/web` | Vite + React + TypeScript | Browser client: Monaco bound to Yjs, file tree, chat |
| API | `apps/api` | Spring Boot 4.1, Java 21, Maven | Identity, workspaces, files, history, Git and job orchestration |
| Collab | `apps/collab` | Node 24 + Hocuspocus (Yjs) | Document synchronization: ticket auth, persistence, merging external changes |
| Agent runner | `apps/agent-runner` | Node 24 + Anthropic SDK | Agent turns on the Claude API; agents edit live documents as their own Yjs clients |
| Executor | `apps/executor` | Node 24 + Docker + Git | Approved jobs in sandbox containers and server-side Git; the only holder of the Docker socket |
| Desktop | `apps/desktop` | Electron | The web app plus a sync bridge that mirrors a workspace into a local Git checkout |
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

## Pull requests

An owner connects a GitHub repository under **Repository** (a token that can push branches and open pull requests; stored encrypted). A session's driver then uses **Finish and open pull request**: the worker commits the workspace on a `converge/…` branch and opens the pull request. Editors can also push the workspace to any other branch from the same dialog. Files deleted, renamed or moved in Converge are deleted on the branch; files Converge never held (binaries, large files, anything added upstream since the last import) are left alone. Desktop members can also **Commit & push** from their own checkout with their own credentials.

## Monitoring

The API (`/api/actuator/prometheus`) and the collaboration service (`/metrics`) expose Prometheus metrics to holders of the internal token; nginx never routes them. Rate limits live in Redis; `RATE_LIMIT_SCALE` multiplies them (raise it for the end-to-end suite and load runs).

Every service carries W3C trace context and writes the trace id on each log line. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP endpoint (an OpenTelemetry collector, Jaeger, Grafana Tempo) and each service also sends its spans there: one per API request, workspace-channel message and subscription, collaboration-service and agent-runner call, document load and store, editor connection (from joining to leaving), agent turn, job and Git operation, joined into one trace across services. Single keystrokes are not spans. To look at them locally:

```powershell
$env:COMPOSE_PROFILES="tracing"; $env:OTEL_EXPORTER_OTLP_ENDPOINT="http://jaeger:4318"; docker compose up -d
```

then open Jaeger on http://localhost:16686.

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

The browser tests use the scripted fake model and fake GitHub, so start the stack with them:

```bash
COMPOSE_PROFILES=fake-model,fake-github AGENT_MODEL_URL=http://fake-model:9100 GIT_ALLOW_INSECURE_REMOTES=true CONVERGE_GITHUB_API_URL=http://fake-github:9200/api RATE_LIMIT_SCALE=50 docker compose up -d --build
```

The baseline load and chaos run (same stack; `CHAOS=1` restarts the collaboration service mid-run):

```bash
CHAOS=1 node tests/load/baseline.mjs
```

A visual check of the web app needs no stack: it serves the built app and answers the API from fixtures, then screenshots sign-in, workspaces, the editor, sessions, lanes, approvals and memory in light and dark, on desktop and phone (into `.impeccable/review/`, which is not committed):

```bash
npm run build -w @converge/web
PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright node tests/visual/capture.mjs
```

With the stack running (fake model), `tests/visual/live.mjs` captures the same surfaces live: two throwaway local accounts share a workspace, so presence stickers, cursor flags, chat, a scripted agent edit and an approval all render for real:

```bash
PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright node tests/visual/live.mjs
```

## Repository layout

```
apps/web           Vite + React client
apps/api           Spring Boot API
apps/collab        Hocuspocus collaboration service
apps/agent-runner  Agent turns on the Claude API (and the scripted fake model)
apps/executor      Sandbox jobs and server-side Git (and the fake GitHub)
apps/desktop       Electron shell
packages/sync-bridge  Live two-way sync between a workspace and a local folder
tests/e2e          Playwright tests (browsers and the desktop app)
tests/load         Baseline load and chaos run
infra/             Compose file and nginx config
docs/              Design document, work log and baseline report
```
