# Converge

A real-time, multi-user development environment: a browser IDE with collaborative editing, presence, version history and (later) Git and isolated code execution.

The full design — architecture, protocols, roadmap and decision log — is in [docs/Converge_System_Design.docx](docs/Converge_System_Design.docx) (Revision 4).

**Status:** live collaborative editing works end to end: accounts, workspaces, a file tree, chat and real-time co-editing in Monaco backed by Yjs, with automated multi-browser tests for persistence and convergence. See [docs/WORKLOG.md](docs/WORKLOG.md) for the decisions behind each step.

## Architecture at a glance

| Service | Path | Stack | Role |
|---|---|---|---|
| Web | `apps/web` | Vite + React + TypeScript | Browser client: Monaco bound to Yjs, file tree, chat |
| API | `apps/api` | Spring Boot 4.1, Java 21, Maven | Identity, workspaces, files, history, Git and job orchestration |
| Collab | `apps/collab` | Node 24 + Hocuspocus (Yjs) | Document synchronization: ticket auth, persistence, merging external changes |
| nginx | `infra/nginx` | nginx | Single origin: `/` web, `/api` and `/ws` API, `/collab` collaboration socket; `/internal` is never routed |
| PostgreSQL 18, Redis 8 | `infra/compose.yaml` | | Durable state; transient fan-out and rate limits |

## Run the whole stack

Requires Docker Desktop.

```bash
docker compose up -d --build
```

Open http://localhost:8000 to see the health of every service. The API's aggregated health (database, Redis and the collaboration service) is at http://localhost:8000/api/actuator/health.

Default database credentials are development-only values from `.env.example`; copy it to `.env` to change them.

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
