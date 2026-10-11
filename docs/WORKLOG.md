# Work log

Decisions made while working autonomously, newest last. Each entry says what was decided and why, so it can be reviewed or reversed.

## 2026-10-12 — Rules, repository and CI

- **Project rules recorded** in `CLAUDE.local.md` (gitignored): nothing leaves the project folder; dependency downloads stay in the project; commits only as `Sarthak-47 <0906sarthak@gmail.com>` with no co-author trailers; CI/CD where needed.
- **Dependency caches moved into the project.** npm uses `.cache/npm` (`.npmrc`); Maven uses `apps/api/.m2/repository` (`apps/api/.mvn/maven.config`). Both are gitignored. Downloads made before the rule existed (the global npm cache and `~/.m2`) were left untouched rather than deleted.
- **Docker images and volumes** necessarily live in Docker Desktop's own storage; that is the one exception to "nothing leaves the project folder".
- **Design doc Revision 4** saved only to `docs/` (the copy in Downloads stays at Revision 3, written before the rule).
- **Git identity** set in the repository's local config only; global config untouched.
- **CI (GitHub Actions, `.github/workflows/ci.yml`)**: API tests with Maven on Java 21; npm ci, lint, type-check and build for web and collab; then a Docker Compose smoke test that boots the whole stack and waits for `/api/actuator/health` to report UP. Runs on pushes to `main` and on pull requests.
- **Branching**: commits go straight to `main` while the project is solo; CI guards every push. Pull requests can be introduced when others join.

## 2026-10-12 — Phase 1: single-user IDE

- **Data access with `JdbcClient` and explicit SQL**, not JPA: every query is visible and reviewable, which suits a project whose point is understanding state.
- **Session-cookie auth with Spring Security 7**; CSRF via the SPA pattern (readable `XSRF-TOKEN` cookie echoed in `X-XSRF-TOKEN`). The client retries once with a fresh token because Spring rotates it at sign-in. Password hashes never enter the session.
- **Non-members get 404, not 403**, for anything inside a workspace, so outsiders cannot probe which workspaces exist.
- **File names follow Windows rules on every OS** (no `CON`/`NUL`, no trailing dot, no `\ / : * ? " < > |`), because the Phase 7 desktop app writes these names into local checkouts.
- **Optimistic locking everywhere**: `row_version` for tree changes, `content_version` for saves. A stale save gets 409 and the UI asks the user to choose "overwrite with mine" or "load theirs" — this is the lost-update problem Phase 3 will remove.
- **Folder moves rewrite descendant paths in one transaction** using `starts_with()` instead of `LIKE`, since `%` and `_` are legal in file names.
- **Monaco bundled locally** (no CDN) with Vite-built workers; the IDE route is lazy-loaded so the sign-in page stays small.
- **Sessions are in memory for now**: an API restart signs people out but loses no data. Spring Session on Redis is a later improvement.
- **Docker Desktop was not running** during the night, and I must not start it from my shell, so the Testcontainers integration tests and the new Playwright end-to-end tests (Gate A: data survives an API restart; stale saves are caught) run in GitHub Actions. Work goes to a branch first and is merged to `main` only after CI passes.
- **Two bugs found only by real-HTTP tests**, both now covered: Jackson 3 (Spring Boot 4) rejects missing primitive fields, which made every rename return 400; and a CSRF rejection was forwarded to `/error`, which required authentication and turned the 403 into a 401 (breaking the client's token retry). MockMvc hid both.

## 2026-10-12 — Phase 2: realtime foundation

- **STOMP workspace channel at `/ws`**, authenticated by the session cookie on the handshake. Only same-origin handshakes are accepted (configurable via `converge.websocket.allowed-origins`), which is what stops cross-site WebSocket hijacking. nginx now forwards `Host` with its port so the origin check compares correctly.
- **Every SUBSCRIBE and SEND is authorized** by `DestinationAuthorizationInterceptor` against workspace membership; unknown destinations are refused. Viewers can subscribe; posting chat needs Commenter; the naive-broadcast lab needs Editor.
- **Chat is persisted before it is broadcast**, so anything delivered is also in history; history uses keyset pagination.
- **File-tree changes and saves become workspace events** published only after the transaction commits (`@TransactionalEventListener(AFTER_COMMIT)`), so clients never hear about rolled-back changes. Clients refetch the tree on tree events; a teammate's save reloads a clean open file in place, or warns if there are unsaved edits.
- **The naive whole-document broadcast (`lab/NaiveBroadcast`) is deliberately kept**, with a test that reproduces the lost edit ("hello A" vs "hello B" → only "hello B" survives). It is the recorded "before" for Phase 3 and is not used by the UI.
- **Simple in-memory broker** for now; multiple API instances will need a STOMP broker relay (design §7.5).
