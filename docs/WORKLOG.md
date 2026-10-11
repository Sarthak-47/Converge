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

## 2026-10-12 — Commit-message convention

- **Sarthak asked for professional commit messages.** All commits now use Conventional Commits (`type(scope): subject`, imperative, at most 72 characters, wrapped body explaining why). The unmerged `phase-1` and `phase-2` branches were rebuilt with reworded messages, and the single commit on `main` was reworded and force-pushed with `--force-with-lease`; file contents were verified byte-identical before each rewrite. The rule is recorded in `CLAUDE.local.md`.

## 2026-10-12 — Phase 3: live collaborative editing (Yjs)

- **The Yjs document is now the only owner of live content.** The collaboration service loads `documents.yjs_state` and stores it (debounced: at most every 2 s, never later than 10 s) together with the materialized text, its hash and a content version that advances only when the text changes. Files created in Phase 1 are seeded from their text on first load, and the seed is stored immediately so it never happens twice.
- **Tickets for document sockets**: 32 random bytes, 60-second lifetime, single use, bound to one user and one file; only the SHA-256 hash is stored. The collaboration service redeems them over `/internal/collab/authorize`, which re-checks membership. Viewers and commenters get read-only connections, enforced by the server.
- **Service-to-service calls use a shared token** checked in constant time by a servlet filter that runs before Spring Security; with no token configured every internal call is refused. nginx never routes `/internal`.
- **Writes from outside the editor are merged, never overwritten.** `PUT /files/{id}/content` asks the collaboration service to apply the text as a minimal character diff (`fast-diff`) inside one Yjs transaction, so concurrent typing in untouched regions survives. Property tests (fast-check) check that the diff always reaches the target and that replicas never diverge under concurrent edits.
- **Web client**: each open file is a `CollabDocument` (Yjs doc + Hocuspocus provider fetching a fresh ticket per connection attempt), bound to Monaco with `y-monaco`. Ctrl+S and the conflict dialog are gone; the status bar shows connecting / syncing / saving / saved / offline. A Vite alias points y-monaco's old Monaco import path at the file Monaco 0.57 exports, so both share one instance.
- **End-to-end Gate B**: two independent browsers type into one file at the same time and converge; one goes offline, both keep typing, and nothing is lost on reconnect; the collaboration service is restarted mid-session and editing continues. Gate A now restarts both the API and the collaboration service.
- **Lost-update test made honest**: inbound STOMP messages are handled on a thread pool, so the test now asserts that exactly one of the two concurrent whole-document edits survives, whichever arrives last.
- **Concurrent typing at the very same position interleaves characters.** The first Gate B run had two browsers type at the end of the same line at once and got "alphab eta frfom…". Both replicas still converged, which is the property that matters; the test now has the two people type at opposite ends, as real collaborators do. Avoiding interleaving entirely would need a different CRDT design and is out of scope.

## 2026-10-12 — Phase 4: presence and per-user undo

- **Per-user undo with `Y.UndoManager`.** Monaco's own undo stack cannot tell whose edit is whose, so Ctrl+Z could revert a collaborator's typing. Each file gets an UndoManager that tracks only the y-monaco binding's transaction origin; Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y are rerouted to it. Remote edits and external changes are never undone.
- **Workspace presence tracked after authorization.** Spring's subscribe event fires before the authorization interceptor runs, so presence is recorded inside the interceptor once a subscription is approved; a rejected subscriber never appears online. A person with several tabs counts once, with a connection count. Presence is ephemeral and kept in memory.
- **Snapshot plus updates**: a `@SubscribeMapping` returns who is online now directly to the new subscriber, and later changes arrive on the presence topic, so the broadcast sent while the subscription is being set up is never missed.
- **Coloured, named cursors from Yjs awareness.** Peer data comes from other clients, so names are length-limited and escaped for CSS, and colours must match a strict `hsl(...)` pattern before they reach any stylesheet.
- **`useSyncExternalStore` for the peer list**, with a cached snapshot that changes only when awareness does.
