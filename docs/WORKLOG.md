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

## 2026-10-12 — Phase 5: team features

- **Adding people by email.** An existing account is added at once; an unknown email becomes a pending invitation that is accepted automatically when that person registers or signs in. This needs no email delivery yet, and invitations are visible only to owners because they reveal addresses.
- **Last-owner guard**: the only owner cannot be demoted or removed; anyone else can leave.
- **Live permission changes (FR-18).** REST calls and STOMP sends are re-authorized on every request already. For long-lived sockets, an after-commit listener asks the collaboration service to set the person's document connections read-only, read-write, or close them (close code 4403), and closes a removed member's workspace-channel sockets through a per-user session registry. Closing all of a removed member's sockets also drops their other workspaces' sockets briefly; they reconnect automatically, which was judged simpler and safer than per-workspace socket surgery.
- **Audit log** (`audit_events`): membership changes, invitations and role changes, written in the same transaction as the change, readable by owners.
- **Health endpoint**: component status stays public for the status page, but details (versions, error messages) are no longer exposed.
- **Fixes found by CI on earlier phases**: Playwright's `setOffline()` leaves established WebSockets open, so offline is now simulated by routing the collaboration socket through the test; the STOMP converter returns raw bytes when asked for `Object`, so list payloads use `List.class`; Monaco renders its own `role=alert`/`role=status` regions, so tests target the app's elements instead.

## 2026-10-12 — Phase 6: history

- **Versions are plaintext snapshots** (design §9.4): taken on request (named checkpoints), automatically for files that have been quiet for 30 seconds since their last change, and always just before an external change (API writes and restores), so every restore can itself be undone. A version identical to the previous one is skipped; numbering is per file and retried on a concurrent insert.
- **Every version reads freshly flushed text**: the API asks the collaboration service to store pending edits first, so a checkpoint never misses the last couple of seconds of typing.
- **Restore is an external change**: the old text is merged in through `apply-text`, so edits made concurrently with the restore survive. Gate D is tested deterministically: one browser goes offline and edits an unchanged region while the other restores; after reconnecting, both converge on the restored text plus the offline edit.
- **Diff view uses Monaco's diff editor** with the live model on the right; the editor stays mounted (hidden) behind the history view so the binding keeps that side current.
- **Deleting files closes their live documents** after commit (close code 4404), including every file inside a deleted folder.

## 2026-10-12 — Phase 7 (part 1): local sync bridge

- **`packages/sync-bridge` is plain Node with no Electron dependency**, so the mirror logic can be tested by running several bridges on separate folders. It talks to the workspace through a small `RemoteWorkspace` interface: an in-memory implementation for deterministic tests, and `HttpRemoteWorkspace` (API + one shared Hocuspocus socket + STOMP events) for the real thing.
- **Local edits are a true three-way merge.** The bridge keeps, per file, the text it knows is on disk and the Yjs state that produced it. A local edit is diffed against that base and applied to a fork of the base state; only the fork's new operations are sent, so Yjs merges them with remote edits made in the meantime. Diffing the live text against the disk (the first design) would have silently reverted those remote edits; it was caught while reviewing the code, before any test ran.
- **Safety rules (Gate F), each with a test**: echoes of the bridge's own writes are ignored; unsynced local edits are merged before any remote change is written; paths that escape the checkout, point into `.git` or `.converge`, are absolute, Windows-reserved or pass through a symlink are refused; remote deletes and differing local copies at first bind go to `.converge/trash`; `.gitignore`, `node_modules` and binary or >1 MB files are never synced; CRLF files keep CRLF on disk while the live document holds LF; writes are atomic (temp file + rename, retried on Windows locks).
- **Two real bugs found by the first test run**: the `ignore` library throws on paths like `../x`, which aborted the whole reconcile (unsafe paths are now checked first and reported as refused); and a line-ending-only change was mistaken for an echo, so the CRLF style was not remembered.
- **Property test**: 40 random interleavings of local writes on two machines, remote edits and dropped connections always end with both checkouts and the workspace identical. A separate test exercises the real chokidar watcher.
- **Test folders live in `.tmp/` inside the repository**, never in the system temp directory, per the project rules.
- **Not yet done**: persisting replicas to SQLite for offline work across app restarts, and hot/cold files (every tracked file currently holds a live replica). Both are follow-ups; neither changes the merge rules.

## 2026-10-12 — Phase 7 (part 2): Electron shell

- **`apps/desktop`** loads the same web app, with context isolation, a sandboxed renderer, no Node in the page, navigation locked to the Converge origin, and IPC accepted only from that origin. The bridge runs in the main process with the window's session cookie.
- **Workspace trust prompt** before any folder is synced.
- **The Electron binary is not downloaded on install** (`ELECTRON_SKIP_BINARY_DOWNLOAD=1` in CI and Docker). Run `npm run setup -w apps/desktop` once to fetch it into `.cache/electron`, then `npm run desktop` (with the stack running) to launch.
- **Not yet verified by running the app**: this machine has no Electron binary yet and Docker was stopped overnight. The bridge itself is covered by unit, property and live-stack tests.

## 2026-10-12 — Desktop sync: merging offline work across restarts

- **Each file's base is persisted in the checkout** at `.converge/state/<fileId>.json` (base text, the Yjs state that produced it, line-ending style), written atomically and in order per file. On the next start, a file that changed on disk while the app was closed is merged three-way against that base, so both the offline edits and teammates' concurrent edits survive; previously the local copy was set aside in the trash.
- **Plain files instead of SQLite** (the design mentioned SQLite): no native module has to be downloaded or rebuilt for Electron, and one small file per tracked document is all this needs. Stopping the bridge keeps saved bases; deleting a file (locally or remotely) removes its base.
- **Known limit**: if the server's document were rebuilt from scratch (for example a database restore to an older backup), a saved base could reference operations the server no longer has; Yjs would then hold those local edits back rather than corrupt anything. Recovering from that case is left for later.
- **CI confirmed the live-stack sync test** (two real bridges against the real API and collaboration service) passes, and `main` now includes the sync bridge and desktop shell.

## 2026-11-20 — Full local verification and a desktop end-to-end test

- **Everything was run locally against Docker for the first time**: 63 Java tests (Testcontainers), 20 sync-bridge tests including the live-stack test, the collaboration-service tests, and all browser end-to-end tests in Chromium. All passed. Playwright's browsers and Electron's binary were downloaded into `.cache/` inside the project.
- **The desktop app now has an end-to-end test** driven by Playwright's Electron support: sign in inside the real app, start syncing a workspace to a folder, and check that typing reaches the file on disk and that a disk save reaches the open editor. It passed on the first real launch of the app.
- **A scoped test hook** (`CONVERGE_E2E_SYNC_FOLDER`) replaces the two native dialogs that cannot be automated: the folder picker returns that folder, and the trust prompt is skipped for that exact folder only. Only whoever launches the app can set it.
- **CI runs the desktop test too**: it fetches Electron, builds the app, makes Chrome's Linux sandbox helper root-owned and setuid (keeping the sandbox on instead of `--no-sandbox`), and runs the suite under `xvfb-run`.
- Test helpers now navigate with absolute URLs, since Electron windows have no Playwright base URL.
- CI's first run of this change failed on a Maven Central rate limit (HTTP 429), unrelated to the change; a re-run passed and `main` was fast-forwarded.

## 2026-11-20 — Phase 8: agents as collaborators

- **`apps/agent-runner`** (Node) runs agent turns on the Claude API through the official TypeScript SDK. Each turn joins the files it touches as its own Yjs client, with an awareness entry labelled "Asha's agent", so teammates watch it type with its own cursor. Deletions apply at once; insertions are typed in small transactions anchored by relative positions, so text people type meanwhile is never overwritten.
- **A manual streaming loop instead of the SDK Tool Runner** (the design named the Tool Runner). Converge needs, after every response, to record usage and enforce the cost cap; at every tool boundary, a cancellation checkpoint; and on a refusal, to drop the response's tool calls. Owning the loop keeps those rules explicit and testable. The request follows the design: `claude-opus-5-5` with effort `high`, adaptive thinking with progress notes into the lane, a token task budget, eager input streaming on the edit tools with every input validated (zod) before it runs, automatic tool choice, and the server-side refusal fallback (`fallbacks: "default"`).
- **Tools in this phase**: `list_files`, `read_file` (live text, numbered lines), `search` (literal, over stored text), `edit_file` (exact, unique match or `replace_all`) and `create_file`. No command execution or deletes until approvals exist (Phase 10). Each turn may change at most 200,000 characters.
- **Revert works at any later time, even after a runner restart.** At the end of a turn the runner saves, per file, its replica (garbage collection off, so it still holds the text the agent deleted) and the Yjs ID ranges the turn inserted and deleted. A revert loads that replica *before* syncing, so the server's collected tombstones cannot replace the deleted text, and undoes exactly those ranges as one new edit. A property test (300 random cases: original text, agent replacement, a teammate typing concurrently) checks the agent's text is gone and every teammate character survives; a separate test covers text the server had already collected.
- **Keys and transcripts are encrypted at rest** with AES-256-GCM (`SECRETS_KEY`), bound to their row by associated data. The browser only ever sees a hint such as "…a1b2". Transcript text is scanned for `sk-ant-` keys and redacted before storage. Without a secrets key, agents are disabled.
- **Sponsorship and permissions**: every turn uses its sponsor's own key and records tokens and cost per response; only the sponsor can stop a turn; any editor can revert a finished turn, claimed by compare-and-set so it happens once. Every runner call is checked again against the sponsor's current role, so removing a member stops their agent at its next tool call.
- **Lanes are per member within a workspace for now**; sessions that group lanes arrive in Phase 9. The Agents tab sits beside Chat and refreshes on `AGENT_*` workspace events. The desktop sync bridge ignores those events.
- **Tests never call the real API.** `FakeModel` is a scripted HTTP server that speaks the Messages API's server-sent events, so the real SDK parses real streams. Directives in the prompt (`@tool`, `@say`, `@refuse`, `@slow`) drive it. It runs in-process for unit tests and as the `fake-model` Compose profile for the end-to-end stack and CI. The real API is used only when a member saves their own key on a stack where `AGENT_MODEL_URL` is empty.
- **Phase 8 exit criterion passes in real browsers**: Asha's agent edits `app.ts` while Ben types in the same file; both editors converge; Ben reverts Asha's turn and only the agent's line disappears.
- **Found while building**: SDK 1.x sends API keys as `Authorization: Bearer` rather than `x-api-key`, so the fake model accepts both.

## 2026-11-20 — Phase 9: sessions, plans, takeover and comments

- **Sessions** hold one task, one plan and a lane per participant; members can also join as visible watchers. Agent turns now belong to a session, a lane is one member's conversation with their own agent, and the runner receives the session's task.
- **The driver** is the member whose agent carries the session and pays for it. It changes only by takeover, handoff or completion, each a compare-and-set on `row_version`. An API test fires two takeovers concurrently and asserts exactly one 200 and one 409. The browser test does the same with two real users clicking at once, and passed 6 of 6 runs.
- **Takeover** stops the previous driver's running turn and starts one on the taker's own key, with the task, the plan (with owners) and the previous turn's latest replies carried over; the agent is asked to say where it resumes. The design says the old turn stops at the next safe checkpoint. Here, cancelling also aborts an in-flight model request, which is safe because a model request has no side effects; tool calls are never interrupted midway.
- **Awaiting takeover**: a driver's turn that hits its cost cap or has its key rejected (the runner now reports a `KEY_REJECTED` code), or a driver who is removed or demoted below editor, flips the session to `AWAITING_TAKEOVER`. The board shows it in an alerts strip. The driver prompting again resumes it. A daily per-member cap is not implemented yet.
- **Plans**: steps always belong to people. Unowned, unstarted steps can be taken at once (compare-and-set); started or owned steps cannot be taken, only handed back by their owner. Commenters can take, finish and hand back steps. Agents get `get_plan`, `propose_plan` (steps owned by the sponsor) and `update_step`, and the API refuses an agent moving anyone else's step; the refusal is returned to the model as a tool error. Handoff moves the driver's unfinished steps to the new driver.
- **Steering**: only the sponsor steers a running turn. Guidance is queued in the runner and delivered after the next tool results. Guidance that arrives just as the model finishes keeps the turn going rather than being dropped, and guidance after the turn has ended is refused, so the composer keeps the text.
- **Comments** attach to a code range, a turn or a plan step. Code anchors are Yjs relative positions created in the browser; the end anchor sticks to the character before it, so text typed just after the range does not join it. The editor highlights open comments, follows them through teammates' edits, and labels a comment "outdated" when its code is deleted. Comments are never deleted; they can be resolved and reopened, turned into a plan step, or sent to the author's own agent, and they stay linked to what they caused.
- **The Commenter role** now means: read everything, chat, comment, and hold plan steps.
- **Agent tests**: 16 runner tests (plan tools, steering, `KEY_REJECTED`), 8 new API tests, and 3 browser tests for Phases 8–9, all against the scripted fake model.

## 2026-11-20 — Phase 10: approvals and sandboxed execution

- **`apps/executor`** is the only service that holds the Docker socket. It claims queued jobs from PostgreSQL (`FOR UPDATE SKIP LOCKED`). In the same transaction it **independently re-checks the approval**:
  - the command is on its own allowlist;
  - the approval belongs to the same workspace, is APPROVED and unused;
  - the approval carries the SHA-256 of exactly this action, recomputed by the executor.

  Only then does it mark the approval used and the job RUNNING. Anything else marks the job FAILED, "Refused by the executor", without running it. Tests cover an altered command, pending, denied and already-used approvals, a hash for another action, and a command off the allowlist (Gate E, enforced where it runs).
- **Commands are allowlisted templates, run as argv with no shell**: `npm test`, `npm run <script>`, `node --test [files]`. The API and the executor each keep a copy of the list; both test suites read one shared fixture of accepted and refused commands, so the copies cannot drift apart. The canonical action JSON is built the same way on both sides and checked by a test.
- **The sandbox** is one throwaway container per job, removed afterwards; leftovers are removed when the executor starts. Its settings:
  - no network;
  - user 1000;
  - all capabilities dropped;
  - `no-new-privileges`;
  - 512 MB of memory and no swap;
  - one CPU;
  - at most 256 processes;
  - a tmpfs `/tmp`;
  - a timeout (default 120 s);
  - an output cap;
  - an environment holding only harmless variables;
  - nothing mounted from the host: the workspace's stored text is copied in as a tar.

  `SANDBOX_RUNTIME=runsc` switches to gVisor. Gate C is tested against real Docker with deliberately arbitrary commands, to show the container holds even if a command slipped past the allowlist:
  - network blocked;
  - Docker socket absent;
  - executor secrets absent;
  - user ID 1000 with no effective capabilities;
  - cgroup memory and process limits in place;
  - the timeout kills the job;
  - output is capped;
  - no containers left behind.
- **The executor itself runs as root** inside its own container, only to reach the socket, which is root-equivalent whoever holds it. This is documented in its Dockerfile. Rootless Docker or gVisor is required before execution is reachable by anyone else (design §11.3).
- **Approvals**:
  - a card stores the canonical action and its hash, the capabilities, the requester and an expiry (10 minutes);
  - any editor or owner answers, and the first answer wins by compare-and-set; tested with two concurrent answers, which give exactly one decision and one job;
  - approving queues the job in the same transaction, after storing the workspace's pending typing;
  - unanswered cards expire, and so do cards left open when their turn ends.

  Editors can also run an allowlisted command directly, for browser-only members: their request is their approval, and the executor checks it the same way.
- **Outcome unknown**: jobs left RUNNING when the executor restarts become OUTCOME_UNKNOWN. They are never retried; the card asks a person to record what happened, once. Assumes a single executor process for now.
- **The agent's `run_command` tool fails closed**:
  - if the card cannot be created or read, the command does not run and the model is told so;
  - a denial or expiry returns at once;
  - cancelling while waiting stops the turn;
  - the model gets the exit code, who approved, and the tail of the output.

  The system prompt now says file contents are data, not instructions. A prompt-injection case, where a README asks the agent to pipe curl into sh, is refused before any card exists.
- **Browser test (Phase 10 exit)**: Asha's agent writes a test file and asks to run `node --test tests/math.test.js`. The card shows the exact command; nothing runs until Ben approves it by name from the board's alert. The output (`pass 1`) streams to both browsers, and the agent finishes with "ran … (exit 0)". A second test denies a command and checks it never ran.
- CI: the node job runs the executor tests, including the Gate C sandbox tests on the runner's Docker. The stack job brings up the executor and runs the Gate E queue tests against the live database.

## 2026-11-20 — Dependency security fixes

- **Electron 44.7 → 44.11.5**: fixes the advisory about compromised eMudhra intermediate certificates. The desktop end-to-end test passes on the new binary.
- **`npm audit fix`** (non-breaking): `undici` 7.30.2 (several denial-of-service and TLS fixes) and `vite` 8.3.8 (dev-server file exposure and `launch-editor` fixes).
- **DOMPurify through Monaco is not upgraded**: npm's only fix is downgrading Monaco to 0.55, a breaking change. Instead, comment text, the only user content Converge renders through Monaco's Markdown hovers, is now escaped so it always renders as plain text: untrusted, no HTML, no links. Revisit when Monaco ships a DOMPurify update.

## 2026-11-20 — Phase 11: workspace memory, overlap warnings and held ranges

- **Notes pinned to code**: decision, gotcha, convention or plain note, anchored by two Yjs relative positions plus the exact text the note was written about. People add them by selecting code and pressing Note; a "gotcha:" prefix sets the kind. Agents use `write_memory`, which pins the note to an exact, unique snippet; ambiguous anchors are refused.
- **Staleness is decided server-side**, in the collaboration service, every time it stores a document. It resolves each note's anchors against the stored document and compares the code now under them with the original text. If the code was deleted, or is less than 60% similar, the note is STALE; if the code comes back (an undo restores the same Yjs content), the note is current again. Only changes are reported to the API, which notifies the workspace. This needs no browser to be open. The checks are context, not authority: a failure is logged and never blocks storing.
- **Agents read and maintain memory**: `read_memory`, `update_memory` (re-pins a note to new code) and `retire_memory`. At turn start, the API adds the relevant notes (the session's files first, stale ones next), overlapping sessions and held ranges to the first message, not the system prompt, so the cached prefix stays stable (design §13.6). If those lookups fail, the turn proceeds and the lane shows "context may be stale" (fail open for context).
- **Overlap warnings**: an agent opening a file now counts as touching it (recorded when the runner asks for its ticket), so overlaps show up while work is in progress, not only after a turn ends. A session shows other active sessions touching the same files from the last 24 hours, and agents are told about them. Agents' cursors are not compared yet.
- **Held ranges (advisory locks)**: an editor selects code and presses Hold, giving a reason; the hold lasts 2 hours by default, 24 at most, and the holder or an owner can release it. Agents see held ranges at the top of `read_file`, and `edit_file` refuses to change them, saying who holds them and why. People are never blocked: the CRDT already prevents lost edits.
- **Bug found by the browser test, fixed everywhere**: workspace events were published only after a transaction committed, so events raised outside a transaction were silently dropped. That covered the collaboration service's staleness report, the scheduled approval expiry, the executor's "job started" notice, and sessions stalled by a member losing access. The publisher now sends those at once (`fallbackExecution`). A regression test spies on the messaging template, and it fails without the fix.
- **Dependency note**: request records now use `Boolean` instead of `boolean` for optional flags; Jackson 3 rejects a missing primitive (seen before, in Phase 1).
- Browser tests: a note follows its code while a teammate types above it, is flagged stale within seconds of the code being rewritten, and can be rewritten or retired; an agent is refused an edit inside a held range, names the holder, and pins its own note.

## 2026-11-20 — Phase 12: Git

- **Connecting a repository**: an owner gives an https remote, the default branch and a token that can push branches and open pull requests. The token is encrypted with the secrets key and bound to the workspace; only a hint is ever shown. `http://` remotes are refused unless `GIT_ALLOW_INSECURE_REMOTES` is set (tests only), and `file://` and other schemes are always refused.
- **Git operations are asynchronous jobs run by the worker** (design §10.3), the executor, which now also holds the Git CLI and one checkout per workspace on a volume. Each operation carries a client-chosen idempotency key, so a retried request returns the operation already started instead of pushing twice.
- **Opening a pull request from a session**: the worker fetches the default branch and rebuilds `converge/<task-slug>-<session-id>` from it. It writes the workspace's stored text over it (the API stores pending typing first), commits with the requesting member as author and a no-reply email, force-pushes the branch, then opens the pull request through the GitHub REST API. The PR is titled with the task, with the plan and owners as a checklist in the description. Running it again updates the same pull request rather than opening a second one. The session view has "Finish and open pull request" and shows the PR link when the worker is done.
- **Converge adds and modifies, never deletes**: files the workspace does not hold are left as they are on the branch, because the workspace was never imported from the repository. Deleting files needs a desktop checkout for now. Importing a repository into a workspace (pull) is still to do.
- **Hardening the worker's Git**, which handles user content:
  - hooks disabled (`core.hooksPath=/dev/null`);
  - no system or global config, credential helper or prompts;
  - `file://` and `ext::` protocols refused;
  - workspace paths with a `.git` segment, `..`, absolute paths or backslashes never written.

  The token reaches Git only through `GIT_ASKPASS` reading an environment variable, never through arguments, config files or logs, and every log is redacted. Tested with a hook planted as a workspace file and with a wrong token.
- **Tests run against a fake GitHub**: real Git over smart HTTP, served by `git http-backend` as a CGI, with authentication required on every request, plus the pull-request endpoints. It runs in-process for the worker's tests (15 tests: commit on top of main, re-runs update the same PR, nothing-to-commit, `.git` paths refused, token never logged, empty repository, sealed-credential compatibility with the API) and as the `fake-github` Compose profile for the browser test. Nothing touches the real GitHub.
- **Desktop commit and push** (design §12.8): "Commit & push" in the sync control waits for the bridge to settle, so every edit typed in the app is on disk and every disk change has been sent. It then commits everything in the member's own checkout, keeps `.converge/` out through `.git/info/exclude`, and pushes with the member's own Git setup and credentials, setting the upstream on first push. The desktop end-to-end test now commits and pushes to a local bare remote and checks the commit.
- **Not done in this phase**: pull, checkout and import from a repository; the branch-mismatch pause on the desktop; webhooks.
- **Docker Desktop had stopped** while this phase was built, and the project rules forbid starting it from the agent shell. The worker's Git tests, the web build and all suites that do not need Docker ran locally. The Testcontainers API tests, the executor's sandbox and queue tests, and the browser tests (including the Phase 12 exit test) were verified by CI only.

## 2026-11-20 — Fixes found by the first CI run of Phase 12

- **The fake GitHub could not serve Git in its container**: Alpine ships `git http-backend` in the separate `git-daemon` package. The worker then misread the failed fetch as "the repository has no main branch". The image now installs `git-daemon`, and the worker treats only "couldn't find remote ref" as an empty repository; any other fetch failure (authentication, network, a server that cannot serve Git) is reported as it is, redacted.
- **`window.prompt` does not exist in Electron**, so in the desktop app the commit message (and comments, notes, holds, checkpoints and handoffs) silently got nothing. All of them now use an in-app text dialog (`askText`, a native `<dialog>`), which also looks the same in every browser. `confirm()` stays, since Electron supports it. Browser tests answer the dialog instead of a native prompt.
- The Phase 9 takeover race test failed once and passed on retry; Playwright's retry absorbed it. It is worth watching.

## 2026-11-20 — Phase 13: metrics, rate limits and the baseline run

- **API metrics** on `/api/actuator/prometheus` (Micrometer):
  - HTTP latency with p50, p95 and p99;
  - `agent_turns_total{status}`, `agent_turn_cost_micros{model}`, `agent_cache_hit_ratio` (cache reads over all input tokens, per model response), `agent_tool_calls_total{tool,outcome}`;
  - approvals decided, `job_duration{status}`;
  - queue depths for jobs and Git operations, and running agent turns.

  The endpoint needs the internal token (the same filter as `/internal`), and nginx refuses it as well.
- **Collaboration-service metrics** on `/metrics` (prom-client, internal token):
  - `websocket_active_connections`, `ws_auth_rejections_total{reason}`;
  - `collab_documents_loaded`, `collab_store_duration_ms`, `collab_store_failures_total`;
  - `external_changes_applied_total{reason}`, update sizes;
  - rate-limited closes, memory checks, and the default Node process metrics.
- **Per-connection limits in the collaboration service** (design §7.4): token buckets of 100 messages/s with a burst of 400, and 1 MB/s with a burst of 4 MB. A client beyond them is closed with 4429. Hocuspocus closes with the code thrown from `beforeHandleMessage`, which was checked in its source.
- **API rate limits** are sliding windows in Redis (the current count plus the previous window weighted by its remaining overlap), one atomic script per check, shared by every API instance. They started as fixed windows; `RateLimitTest` then failed in CI because its attempts straddled a window boundary, which is exactly the hole a fixed window leaves (twice the limit around boundaries). The limits cover:
  - sign-in, per email and per client address (`forward-headers-strategy: native`, so the address comes from nginx);
  - sign-up, per address;
  - agent prompts, per member (each spends their key);
  - approval cards, per turn;
  - direct jobs, per member;
  - Git operations, per workspace;
  - comments and notes, per member.

  Over the limit is a 429 with `Retry-After`. If Redis is down the limits are skipped and logged: availability wins, and the database rules (single-use tickets, approvals, compare-and-set) still hold. `RATE_LIMIT_SCALE` multiplies every limit; the end-to-end suite raises it because every test user signs up from one address, and integration tests turn it off except in `RateLimitTest`, which runs against a real Redis.
- **The baseline run** (`tests/load/baseline.mjs`) drives real Yjs clients through nginx with single-use tickets and an artificial 50–300 ms send delay. It reconnects 10% of them mid-run and, with `CHAOS=1`, restarts the collaboration service. It measures:
  - propagation percentiles (one process, so one clock);
  - delivery ratio;
  - reconnect and restart recovery times;
  - convergence once typing stops;
  - the cost of scripted agent turns from the API's ledger.

  CI runs it after the end-to-end tests and publishes the report as the job summary and an artifact; it fails if the replicas do not converge. `docs/BASELINE.md` records the first run.
- **Not done**: OpenTelemetry tracing across services; Toxiproxy fault injection (the chaos step restarts the service instead); a daily per-member cost cap; signed, auto-updating desktop builds, which need the owner's code-signing certificates.
- **A CI-only surprise**: GitHub Actions defines `GITHUB_API_URL` itself, and a workflow cannot override `GITHUB_*` variables. So the stack's worker called the real api.github.com with the fake test token (a harmless 401, but the wrong host). The Compose variable is now `CONVERGE_GITHUB_API_URL`, which maps to the worker's `GITHUB_API_URL` inside the container.
- **First baseline (Phase 13 exit)**, recorded in `docs/BASELINE.md`:
  - 40 clients with a 50–300 ms send delay: propagation p95 289 ms, which is the simulated network; the server adds about 1 ms;
  - no update lost through reconnects and a restart of the collaboration service;
  - 2.0 s to resync everyone after the restart;
  - convergence within 0.5 s of typing stopping;
  - $0.032 per scripted agent turn, matching the ledger exactly.

## 2026-11-20 — Remaining items: daily cap, larger load runs

- **Daily agent spending cap** (design §13.5): over any 24 hours a member's agent turns may spend at most `AGENT_DAILY_CAP_MICROS` (default $20), on top of the per-turn cap (default $2). Each new turn gets the smaller of the per-turn cap and what is left today, so reaching the daily cap mid-turn ends the turn as BUDGET_EXCEEDED, which puts a session they drive up for takeover. A member at the cap is refused new turns until earlier spending ages out. The composer shows "Last 24 h: $x of $y" (`GET /api/v1/me/agent-spend`).
- **Importing a repository** (design §10.2, "pull"): "Import files from main" in the Repository dialog queues a `PULL` operation. The worker fetches the default branch (shallow) and reads every regular text file. Symbolic links, submodules, binaries (NUL bytes or invalid UTF-8), files over 1 MB and unsafe paths are skipped and reported. It sends the files to the API in batches of 100, which applies them as the person who asked: new files and folders are created, and changed files go through the usual external-change path (a version first, then apply-text), so anyone typing in them keeps their edits. Nothing is deleted. The dialog lists recent operations with their counts. Creating a file by path now validates every segment before creating any folder, so a bad path leaves nothing half-made.
- **Branch mismatch pauses desktop sync** (design §12.8): while syncing, the desktop app checks the checkout's branch every 1.5 s. The expected branch is the workspace repository's default branch, or, without a connected repository, the branch checked out when sync started. On a mismatch, including a detached HEAD, it stops the bridge (keeping its saved bases) and shows "Sync paused: the local branch … differs …". Switching back restarts the bridge, which merges anything that changed on disk meanwhile through the same tested path as edits made while the app was closed. Commit & push is refused while paused. The desktop end-to-end test checks out and commits on another branch, checks that nothing reached the workspace, switches back and checks that typing reaches the disk again.
- **Tracing across services** (design §16.3), first attempt replaced below:
  - **API**: W3C trace context through Spring Boot's OpenTelemetry support. Every request has a trace ID that appears in its log lines. Calls to the collaboration service and the runner go through Boot's instrumented `RestClient.Builder`, so they carry `traceparent`. Spans are exported over OTLP only when `TRACING_EXPORT=true`, with `OTLP_TRACES_ENDPOINT` set.
  - **Node services**: a 20-line W3C helper rather than the full OpenTelemetry SDK. The runner continues the API's trace for a whole agent turn: its log lines and every call back to the API share that trace ID. The collaboration service logs each external change (restore, import, apply-text) with the caller's trace, and the executor uses one trace per job.
  - **CI check**: one agent turn's trace ID appears in both the runner's and the API's logs.
  - **Not exported yet**: Node spans, which would need the OpenTelemetry SDK.
- **Fault injection with Toxiproxy** (design §22.6): a `chaos` Compose profile routes the collaboration service's database connection and the API's calls to the collaboration service through Toxiproxy (`COLLAB_DB_HOST`/`COLLAB_DB_PORT`/`API_COLLAB_URL`). `tests/chaos/faults.mjs` runs three scenarios in a CI job of its own:
  1. the database 400 ms slower: two people's typing converges and is still stored;
  2. the database unreachable while they type: replicas keep converging, and everything is stored once it returns;
  3. the collaboration service unreachable from the API: an API write answers 503, changes nothing, and works again once the fault clears.

  The baseline and fault scripts share their session helpers (`tests/load/stack.mjs`).
- **Desktop branch check, found by CI**: `git rev-parse --abbrev-ref HEAD` fails on a branch with no commits, so a freshly initialised checkout looked like "not Git" and never paused. The app now uses `git symbolic-ref`.
- **Caught by the stack, missed by the API tests**: in Spring Boot 4 the `RestClient.Builder` bean comes from its own module (`spring-boot-starter-restclient`), so the API failed to start once the service clients took the builder. The integration tests mock those clients and never ran their constructors. Added the module, and `WiringTest`, which builds the real clients from the context.
- **Tracing, second attempt**: Spring Boot's OpenTelemetry starter did not put trace IDs in the API's log lines as configured, and that could not be debugged locally with Docker down. It is replaced by an explicit, unit-tested `TraceContext`:
  - incoming: a first-in-chain filter continues the caller's W3C `traceparent` (or starts a trace), puts the trace ID into the logging context (every API log line now reads `[trace=…]`) and returns it as `X-Trace-Id`;
  - outgoing: a client interceptor sends `traceparent` on calls to the collaboration service and the runner.

  The CI check (one agent turn's trace in both the runner's and the API's logs) stays. Exporting spans (OTLP) is not done; it would need the OpenTelemetry SDK in each service.
- **The fault script crashed** on an unhandled WebSocket error when closing an editor mid-reconnect; its sockets now ignore connection errors, which the scenarios measure anyway.
- **The same crash in the runner**, found by the session takeover race in CI: a takeover cancels a turn whose collaboration socket is still connecting, ws then emits an unhandled 'error' and the runner process exited, so every later agent call answered 503. The runner's socket class now keeps an error listener of its own (the provider's handlers are gone by then; the connection state is tracked by the provider anyway).
- **The fault job hung for 20 minutes with no output**: overall time limits on polling are not enough when a single request stalls behind an injected fault. Requests in the load and fault scripts now time out after 20 s, each check after 5 s, editor sync after 30 s, and the run after 10 minutes. Each scenario logs its start, and a failing one is recorded without stopping the others. The CI step now uses `pipefail` (it piped through `tee`, which would have hidden a failure), and the job has a 30-minute limit.

## 2026-11-20 to 21: Visual redesign of the web app

Sarthak asked for a UI that is "eye catching" in both light and dark mode, using the Impeccable design skill.

- **First attempt, rejected:** a "cyanotype" look (Prussian-blue gradient bands, a marigold accent, floating rounded sheets). Two finish reviews passed most of it, but Sarthak judged it "ai slop". The cause: the skill's direction step (a dice roll over candidate worlds plus a decision page) had been skipped, and a familiar template was decorated instead of a world being chosen.
- **Direction chosen properly:** the roll dealt seven grounded candidates and six catalog challengers. Sarthak picked the assigned one, **Sticker Lid**: every person and agent is a die-cut sticker in their own colour, on presence, cursor flags, chat and lane headers, like a laptop lid. Lemon is reserved for primary actions and Live. State is carried by shape (filled, dot, dashed, dotted, hollow ring), never by a person's colour. Four disciplines were borrowed from the declined challengers: state by shape, one strict type scale (12/14/17/22/30), the daily agent budget as a fixed-capacity tape, and the open file owning the stage.
- **Review fixes:** three finish-review rounds ended in "ship". The main fixes were per-colour ink chosen by contrast (`inkFor`), you and chat authors shown as stickers, the sign-in as one lid in both themes, and phone layouts that give the editor most of the height and never clip the connection state.
- **Polish after "still looks AI generated":** the stickers on the sign-in now cluster and overlap like a real lid. Panels are flat, and only stickers cast shadows or tilt. Roles are plain text, so a pill always means a state. Workspaces is a ruled ledger. Explainer and hero copy was cut to one plain line.
- **Tests:** four end-to-end assertions matched the "✓"/"✗" glyphs, which are now drawn icons. They now assert the tool line's state (`.agent-tool.ok` / `.failed`). Screen readers get "Done:" / "Failed:" as hidden text.
- **Recorded:** `apps/web/DESIGN.md` and `.impeccable/design.json` hold the system as built; `apps/web/PRODUCT.md` holds the product facts the design work relied on.
- **Not seen rendered with real data yet:** the Sessions tab, lanes, the budget tape, presence stickers and the Live state. The end-to-end suite drives them, but every visual capture used a fixture backend, because Docker Desktop was not running.
- **Comic moments (decided while Sarthak was away; he said he liked the "comic vibe"):** chat messages are ink-outlined speech balloons whose tail points at the author's sticker, with your own tinted in your colour; decided approvals get a rotated rubber stamp (APPROVED, DENIED in red, EXPIRED dotted). Both are CSS only, so test text and accessible names are unchanged; the stamp's text is hidden from screen readers because the sentence beside it already says who decided. Kept out of the editor itself, which stays plain.
- **First rendered look at the Sessions and Memory panels** (fixture backend): replaced the last emoji icons (comment), gave one-word names one initial, unstruck failed tool lines, and gave a session's primary action its own row.
- **A visual check without the stack** (`tests/visual/capture.mjs` and `fixtures.mjs`): serves the built app with `vite preview`, answers the API from fixtures and screenshots eight surfaces in both themes on desktop and phone. It runs Vite's entry point directly rather than through `npx` and a shell, because on Windows the shell exited before the kill reached the server, which kept leaving a preview server on the port.
- **Sticker colours no longer collide** (up to six members): people first got one of six colours by a hash of their id, so two could share one (the fixtures showed Asha and Ben both in tomato). Inside a workspace the colours are now dealt in roster order (join time, then name), which every client reads the same way, before any file opens, so the colour each editor announces through awareness agrees with everyone else. A membership event re-deals them. Outside a workspace, and for anyone not on the roster, the hash remains the fallback. A seventh member shares the first colour again.
- **The design's full load scenario, run by hand** (100 clients, 10 workspaces, 180 s, collaboration service restarted mid-run): everything converged, propagation p95 288 ms (the artificial delay's own p95), recovery from the restart 2.1 s. Recorded in `docs/BASELINE.md`. The run itself was marked failed for the same reason the chaos job once was: `tee` into a `.tmp/` that does not exist on a fresh runner. The step now creates it and uses `pipefail`.
- **Executor startup race, seen in the same run:** on a fresh stack the executor queried `jobs` before the API's Flyway migrations had created it, crashed, and came back only through the container restart policy. It now waits for the schema (up to two minutes) and logs `WAITING_FOR_SCHEMA`. Its database pool also lacked the `'error'` listener whose absence crashed the collaboration service under fault injection; added.
- **The redesign seen live** (Docker was running after all): `tests/visual/live.mjs` sets up two local test accounts sharing a workspace, opens the editor in two browsers, chats, and runs scripted agent turns in a session. In both themes the Live pill, presence stickers, a remote cursor flag, the agent's applied edit, chat balloons, a pending approval, the lane sticker and the budget tape all render as designed; nothing needed fixing. The load helper now builds email addresses from a slug of the name, since a name with a space made an invalid address.

## 2026-11-21: Closing the functional requirements

A pass over the design's functional requirements (§3.1) against the app found four gaps; Sarthak asked for the app to be finished.

- **FR-02, rename and archive workspaces:** the API could already do both, but nothing in the UI offered them, and "archived" was only a label. Owners now get a settings dialog (the gear beside the workspace name). Archiving makes the workspace read-only for everyone: `WorkspaceAccess.require` refuses anything above the viewer role with 409, realtime tickets come out read-only, and open editors are switched to read-only at once through the same collaboration-service call that role changes use. Settings and membership stay open (`requireIgnoringArchive`), so an owner can unarchive. Rename, archive and unarchive are audited, and a `WORKSPACE_UPDATED` event updates every open tab. Archiving uses its own event rather than `AccessChanged`, because sessions treat a demoted driver as a takeover.
- **FR-04, moving files:** files and folders move by dragging them onto a folder, or anywhere else on the rail for the top level; a Move action asks for the destination path, for keyboards. The API already refused moving a folder into itself.
- **FR-11, comparing two versions:** History compared a version only with the live text; a "compared with" control now picks any other version.
- **An end-to-end spec covers all three** (`workspace-admin.spec.ts`), including a second member seeing the rename and the archive live. Writing it showed that the e2e helper's `getByLabel('Name')` also matched the rows' new "Rename x" buttons (Playwright matches labels as substrings), so the helpers now match exactly.
- **Hot and cold files on the desktop mirror** (design §12.3): every tracked file used to hold an open live document, one connection per file, which does not scale to a large checkout. A file with no local or remote edits for five minutes now goes cold: its replica is closed and only its base (text plus Yjs state) is kept. A local edit, or a stored change on the server, warms it again through the same three-way merge used when the app restarts with a saved base, so no new merge rules were needed. A cold file's echo of its own write does not warm it.
- **Stored changes are now announced:** `FILE_SAVED` fired only for writes through the API, so a cold file would never have heard of a teammate's typing. The collaboration service's store now reports whether the text changed (one `update … returning`), and when it did, it tells the API (`POST /internal/files/{id}/stored`), which publishes `FILE_SAVED` to the workspace. The desktop remote turns those into content events instead of tree refreshes. Checked on the live stack: a typed change logged `DOCUMENT_STORED … "changed":true` and the row moved to the next version.
- **A flaky sync test explained:** about one run in twelve, a bridge test failed in cleanup with `EPERM` on Windows. Two machines in a restart test share one folder, and cleanup deleted it twice in parallel. Cleanup now dedupes the folders and retries; fifteen full runs passed.
- **GitHub push webhooks** (design §10.2, listed as "later"): owners turn on automatic import in the Repository dialog, which shows the payload URL and a fresh secret once (stored encrypted, like the token). GitHub's deliveries go to a public `POST /api/v1/git/webhooks/{workspaceId}`, trusted only after its HMAC-SHA256 signature checks out in constant time; an unknown workspace, a workspace without a webhook and a wrong signature all answer 404, so nothing is revealed. A push to the default branch queues the same import as the button, as the person who connected the repository, keyed by GitHub's delivery id so redeliveries never import twice; pings are answered and other events ignored. Covered by an API test and an end-to-end test that signs a delivery against the fake GitHub.
- **Known limit, recorded:** API sessions are held in memory, so restarting or redeploying the API signs everyone out (seen while rebuilding the stack). A shared session store (Spring Session in PostgreSQL) would fix it and is also what more than one API instance needs; it would change how every API integration test passes sessions, so it is left as a deliberate follow-up.
- **Workspace activity (FR-15) is visible now:** the audit log was recorded and had an owner-only endpoint, but nothing showed it. Workspace settings now lists the latest actions as sentences ("Asha renamed the workspace to …", "Ben approved a command", "turned on automatic import"), refreshed after each change made there. Reading it stays allowed in an archived workspace: it was the one read that needed more than the viewer role, so the archive rule would otherwise have hidden it.
- **WebSocket connection ids in the logs** (design §3.2, observability): the collaboration service now logs the connection id on join, rejection, rate limiting and a new `DOCUMENT_LEFT` line, and the API logs every workspace-channel connection and disconnection with its STOMP session id and user. With the trace ids already on every line, one socket's life can be followed end to end.

## 2026-11-21: Pushes that delete (decided while Sarthak was away)

- **Deletes, renames and moves now reach GitHub.** A push used to add and change files only, so a file deleted or moved in Converge stayed on the branch under its old path. Deleting "everything on the branch the workspace lacks" would have been wrong: an import leaves out binaries and files over 1 MB, and the default branch may have gained files since. So each repository now keeps the paths Converge *knows* are on its default branch (`git_repositories.known_paths`, V13): an import sets them to what it brought in (minus anything the API refused), and a push adds what it wrote. A push deletes on its branch only the known paths the workspace no longer holds. Paths a push deleted stay known until the next import, so later pushes keep deleting them as long as the workspace lacks them. Reconnecting the same repository and branch (a new token) keeps the set; another repository or branch starts empty, so nothing is deleted there until it has been imported or pushed.
- **Git sees workspace paths literally** (`GIT_LITERAL_PATHSPECS`): a file named `[ab].txt` used to be a pattern to `git add` and would have been to `git rm`.
- **Pushing to a branch from the web app:** the API has had `POST …/git/pushes` since Git support landed, but only sessions' pull requests used the worker. The Repository dialog now has a "Push to branch" form for editors, suggesting `converge/<workspace-name>`.
- **No pushes to the default branch:** the worker rebuilds its branch from the default branch and force-pushes it, so pushing to the default branch itself could drop a commit that landed in between. The API refuses it; changes reach the default branch through a pull request.
- **Tests:** an executor test (deletions, a held path never deleted, unsafe and unknown paths ignored, a bracketed name taken literally), an API test (the known paths survive a new token but not a new repository; pushing to `main` refused), and an end-to-end test that imports, deletes and moves files in the UI, pushes, and checks the branch on the fake GitHub.

## 2026-11-22: Imports that delete, and getting deleted files back

- **An import now deletes what was deleted on GitHub.** Each import records what it brought in, as path and SHA-256 of the text (`git_repositories.imported_files`, V14). The next import finds the recorded files that are gone from the branch entirely (a file that is merely skipped now, say because it grew past 1 MB, still counts as there) and asks the API to delete them as the person who asked. The API deletes a file only while its stored text still has the recorded hash, which is the same SHA-256 the collaboration service stores. A file someone edited here since is kept, and the import reports it among the skipped files with the reason. It stays on record until it is deleted or reimported, so it is not lost track of. Reconnecting another repository or branch starts the record empty, like the known paths for pushes.
- **Recently deleted:** deleting only ever marked a file, but nothing could bring one back, which mattered once imports delete. The file list has a "Recently deleted" button listing files deleted in the last 30 days whose path is free again (one per path, newest first). Restore puts the file back at its path with its text and history, creating again any folders on the way that were deleted. A path taken again is refused with a conflict.
- **Docker Desktop's WSL machine had stopped responding** (`HCS_E_CONNECTION_TIMEOUT`), which explains yesterday's stalled image builds and hung local Testcontainers runs. Sarthak restarted it.
- **Tests:** API tests for the deletion rule (deleted, kept when changed here, missing ignored, refused unless the import is running) and for restore (folders recreated, editors only, taken paths refused), and an end-to-end test that imports, edits one file, deletes two on the fake GitHub, imports again, and restores the deleted one with its text.

## 2026-11-22: Spans exported over OTLP

- **Spans now leave the services.** Every service already carried W3C trace context and logged the trace id, but recorded no spans, so a tracing backend had nothing to show. Each service now records spans and, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, sends them over OTLP/HTTP with JSON bodies, the format every collector and backend accepts (OpenTelemetry Collector, Jaeger, Grafana Tempo). Unset, nothing changes.
- **Why not the OpenTelemetry SDKs:** the services already propagate context by hand, the same way in Java and three Node copies. Writing finished spans down was the only missing piece. A small batching exporter in each service (`SpanExporter.java`, and the shared `trace.ts`) does that without new dependencies or an agent. It is bounded: at most 4096 spans wait, batches go out every two seconds from a background thread or timer, and a slow or absent backend means dropped spans and a warning, never slower requests.
- **What becomes a span:** each API request (named by its route pattern, not including health and metrics scrapes), each internal call into the collaboration service and the agent runner, each agent turn (it outlives the request that started it), each executor job, and each Git operation.
- **A proper tree across services:** outgoing calls used to send a random span id as the parent, which was harmless while no spans were recorded. They now send the caller's own span id, so the callee's span hangs under it. Checked on the live stack with Jaeger: one agent turn shows as browser request → API → agent runner request → `agent.turn` → every callback to the API, with no missing parents; a pull request shows the API's call to the collaboration service under it.
- **Trying it:** `COMPOSE_PROFILES=tracing OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 docker compose up -d` adds Jaeger (UI on port 16686).
- **Tests:** a Java test against a local stand-in collector (payload shape, `/v1/traces` path, nothing recorded without an endpoint, route names, parent ids), a Node test of the same for the shared helper, and a check that the three Node copies of `trace.ts` stay identical.

## 2026-11-22: Sessions in PostgreSQL

- **Restarting the API no longer signs everyone out.** Sessions lived in the API's memory, so every restart or redeploy signed everyone out, and a second API instance would not have known anyone. They are now kept by Spring Session in PostgreSQL (`spring_session` tables, V15, Spring Session's own schema with room for long email addresses as the principal name). Checked on the live stack: register, restart the API container, and `/auth/me` still answers with the same person. The WebSocket channel, which authenticates from the HTTP session, works unchanged (`workspace-admin.spec.ts` against the rebuilt stack).
- **The cookie needed setting by hand.** With Spring Session, Boot 4 no longer applied `server.servlet.session.cookie.*`, so the cookie came out named `SESSION` without HttpOnly or SameSite. The new test caught it. `SessionConfig` now sets the name, HttpOnly, SameSite=Lax and Secure from the same properties, and the 12-hour timeout is set for Spring Session too.
- **What is stored:** the security context only, and its principal is the user without the password hash (`withoutPassword()`, as before). The test checks that neither the hash nor the password is in the stored bytes.
- **Tests:** the existing integration tests pass `MockHttpSession` objects around, which a cookie-based session store ignores, so they keep container sessions by excluding the two session auto-configurations. `SharedSessionTest` runs with the real store and only the cookie, the way a browser does: the session is a row keyed to the person, the cookie alone opens it, and signing out deletes the row.
- **Remaining known limit:** desktop builds are unsigned. Sarthak confirmed signing will not happen, because the certificates cost money.

## 2026-11-22: A save caught halfway is no longer merged

- **A real bug behind a "flaky" test.** A sync-bridge test failed once in CI, with only a teammate's appended line left. When a remote edit arrives, the bridge first reads the local file, to merge in any edits not yet sent. Editors save by truncating and rewriting, so that read can land halfway through a save, see an empty file, and merge "delete everything". Unchanged, this could wipe a file in real use whenever a teammate typed while you saved.
- **Fix:** whenever the disk text differs from the last synced text, the bridge reads again until two reads 30 ms apart agree, and only then merges. This applies to remote writes, local changes and warming a cold file. A file that matches its base, the usual case, costs nothing extra. A missing file is treated the same way, so a delete-and-recreate save is not taken as a deletion.
- **Test:** truncates the file, lands a remote edit, then completes the save. Before the fix it lost the teammate's line every time; after it, both edits survive.

## 2026-11-22: Review of the day's changes

- **Unreadable sessions no longer fail requests.** Stored sessions are Java-serialized. After an upgrade that changes a stored class, a session saved by the old version no longer deserializes. Spring Session then threw on every request carrying that cookie, a 500 until the cookie expired; a test reproduced it with corrupted bytes. `SessionConfig` now reads unreadable attributes as absent and logs a warning, so the person is just asked to sign in again.
- **Span export costs nothing measurable:** 2 000 authenticated API requests with export on and off differ less than two runs of the same setting (see `docs/BASELINE.md`; the script is `tests/load/api-latency.mjs`).
- **Checked and left as they are:** an import's recorded hashes follow the merged text, so a file merged with local edits is never deleted later. Restoring one file of a deleted folder recreates the folder, and restoring its siblings afterwards finds that folder. A push's deletions never include a path the workspace still holds, unsafe paths or paths unknown on the branch.

## 2026-11-22: Housekeeping, devices, live-channel spans, load rerun

Sarthak asked for all four follow-ups: purge old deletions, a sessions page, spans for the live channels, and a rerun of the full load test.

- **Deleted files are purged after 30 days.** Deleting a file only marks it, which is what makes "Recently deleted" possible, but nothing ever removed the rows, so deleted text and history were kept forever. An hourly job (`DeletedFilePurge`) removes files deleted more than 30 days ago (`converge.files.keep-deleted`), and their text, versions and notes cascade with them. A folder goes only once nothing still kept is inside it. Several API instances can run it at once.
- **Signed-in devices.** Sessions now being rows made this possible: your name in the top bar opens a list of where you are signed in, as "Chrome on Windows" or "Converge desktop on macOS" from the User-Agent at sign-in, with this device first. Each other device can be signed out, or all at once with "Sign out everywhere else". Sessions are named by a short hash of their id, never the id, since that is what the cookie carries; the test checks no listed value is a session id. Someone else's session answers 404. Signing out this device stays the Sign out button.
- **Dropped from the earlier suggestion:** ending someone's sessions when they are removed from every workspace. They still have an account and may join other workspaces, so signing them out would only be confusing; workspace access is already revoked live.
- **Correction: the API is still single-instance.** Moving sessions to PostgreSQL removed one obstacle to running several API instances, and I wrote as if that were enough. It is not: the workspace channel (chat, presence, live events) still uses Spring's in-memory STOMP broker, so clients connected to one instance would not hear events published on another. The README lists this as a known limit again. Fixing it means a broker relay or fanning events out through Redis, and moving presence out of memory; that is a feature of its own, left for Sarthak to decide.
- **Spans for the live channels.** Spans covered HTTP calls, turns, jobs and Git operations, but not the two WebSocket channels. Now the API records a span for each workspace-channel message it handles and each subscription (`STOMP SEND /app/workspace/{id}/chat`), with the trace in the logging context while it runs, as for an HTTP request; a client may continue its own trace with a `traceparent` STOMP header. The collaboration service records each document load and store, and each editor connection from joining to leaving. Redeeming the ticket is a child of the connection span, and the store's report to the API is a child of the store span. Individual Yjs updates (every keystroke) are deliberately not spans: at typing speed they would swamp any backend and say nothing the store spans do not. Checked in Jaeger after the realtime and team specs: subscriptions, a chat send, connections, loads and stores, all linked as described. An API test checks the STOMP spans against a stand-in collector.
- **The design's load scenario, rerun** (100 clients, 10 workspaces, 180 s, collaboration service restarted mid-run) on main after all of the above: propagation p50 / p95 176 / 289 ms (was 177 / 288), every one of 112 232 updates delivered, recovery from the restart 2.2 s (was 2.1 s). Recorded side by side in `docs/BASELINE.md`.

## 2026-11-22: Several API instances

Sarthak asked for this to be done too, so the API is no longer limited to one instance.

- **What was per-instance:** a survey of the API's in-memory state found three things: Spring's in-memory STOMP broker (chat, workspace events, presence updates), the presence map, and the list of each person's open sockets (used to cut off access at once). Sessions, tickets, rate limits and everything else were already in PostgreSQL or Redis.
- **Events through Redis.** `ClusterBus` replaces direct sends. It delivers to this instance's own subscribers and publishes the same message on a Redis channel; every other instance repeats it to its own subscribers. Orders to close a person's sockets travel the same way. The payload is converted to bytes once, with the broker's own converter, and those exact bytes go to every client, so a frame looks the same whichever instance sent it. Two details mattered. Sending ready bytes through `convertAndSend` made Spring's JSON converter encode them again as a base64 string, so they are sent as a prebuilt message instead. And local delivery never waits for Redis: with Redis down, each instance still serves its own clients, as the rate limiter already fails open.
- **Presence in Redis.** Each instance writes its viewers into a hash per workspace, tagged with its id, and reads the whole hash. It proves it is alive with a 30-second key refreshed every 10 seconds. Viewers of an instance that died without a clean shutdown drop out when its key expires, and are removed from the hash on the next read. A clean shutdown deletes the key at once. Each instance also keeps its own viewers in memory, which is what it shows if Redis is unreachable.
- **Scheduled jobs, checked one by one:** approval expiry (`update … returning`), ticket cleanup and the purge are single statements, and automatic versions already refuse a duplicate (same text, unique version number). All are safe on every instance at once. Flyway takes a lock, so two instances starting together migrate once.
- **Tests:** `ClusterBusTest` runs one instance against a real Redis and plays the other through the channel and the presence keys. It checks that a local chat message is published, that another instance's message arrives byte for byte, that a remote close order closes the socket, and that presence counts only live instances' viewers. CI's end-to-end job now runs two API instances behind nginx. Locally, the whole suite (23 tests) passed against two instances, whose connections split 23 and 26.
- **Single-instance tests** keep the cluster off (`converge.cluster.enabled=false`), since they have no Redis.
- **A test race that two instances exposed.** The session takeover test clicks "Take over" on two pages at once and expects exactly one winner. A test's two clicks are never truly simultaneous, though. In CI with two instances, the first takeover's update reached the second page before its click, so that click carried the new version and rightly took over from the new driver. Both requests succeeded, and neither page showed the "someone else took over first" notice. The server's compare-and-set was right. The test now holds back both pages' session reloads for a moment, so both requests carry the same version and really race. It passed three runs in a row against two instances.

## 2026-11-22: Several collaboration-service instances

- **Documents in step across instances.** With `COLLAB_CLUSTER=true`, Hocuspocus's Redis extension (version 4.7, matching the server) keeps every instance's copy of a document in step. It also makes an instance that opens a document already live elsewhere wait for that instance's state first, so an API call landing on any instance, such as applying a restore's text, sees the latest document. It takes a Redis lock around storing.
- **Stores that cannot go backwards.** Two instances' copies of one document can differ by a few milliseconds of edits still in flight. A store wrote the whole state, so a slightly behind copy stored after a newer one would have taken edits back. In cluster mode a store now merges this instance's state with the stored one under a row lock, so stores only ever add. Nothing else writes the stored state.
- **"Store now" reaches every holder.** Before a checkpoint, a push or an import, the API asks the service to store a document first. With two instances that request could land on the one not receiving the typing, which stored a copy missing the last keystrokes, so a checkpoint saw no change (an end-to-end test caught this). The instance asked now stores its own copy, counts the instances subscribed to the document's Redis channel, asks each of them to store, and waits for their answers, for up to three seconds. Because stores merge, the result holds every edit.
- **Closing a deleted file and applying access changes** are broadcast to every instance, since anyone's connection may be on any of them.
- **A test helper that assumed one instance:** after a restart, waiting for one healthy answer was not enough, because nginx could send the next request to an instance still starting. `waitForStack` now waits for six healthy answers in a row.
- **Result:** the whole end-to-end suite (23 tests) passed against two API and two collaboration-service instances, with connections split 50 and 45 and no store request timing out. That includes convergence through offline work and a collaboration-service restart. CI now runs this setup.
- **Still single-instance, documented in the README:** the agent runner, which holds running turns in memory, and the executor, which is single by design so that an interrupted job is never re-run.


## 2026-11-22: Closing gaps from the comparison, and a darker dark mode

A comparison with Replit, Zed, Cursor and others found Converge distinctive (agents as live co-editors, shared sessions with per-member keys and budgets, approvals, revert, self-hosting) but behind on breadth. Sarthak asked to close what can be closed.

- **Code intelligence across files.** Monaco's TypeScript service only knew open files, and models were named by file id, so an import of another workspace file showed as an error and go-to-definition could not follow it. Models are now named by workspace path. Every other TS/JS file is given to the service as a background source (up to 400 files of 256 KB) and refreshed when someone else changes it. "Cannot find module" is not shown for packages, which live outside a workspace. Checked in the browser: `greet(42)` in one file is flagged against `greet(name: string)` declared in another.
- **Model choice per turn.** Members pick Opus 5.5, Sonnet 5.5 or Haiku 5.5 beside "Send to agent": a cheaper model for quick edits, the strongest for hard ones. The API offers `converge.agent.models` (the default first) and refuses anything else. Every parameter the runner sends was checked against the API reference and the task-budget docs. All three accept effort, adaptive thinking and task budgets. Haiku 5.5 rejects server-side fallbacks and has no progress-update thinking display, so the runner sends it neither. A Haiku turn ran end to end against the fake model.
- **Dark mode, properly dark.** Sarthak saw dark mode as "still white". Every selected or emphasised pill (the active tab, the theme switch, monograms, done badges) was filled with the off-white text colour, and the panels were mid graphite. Dark is now ink-black, with a darker hinge and a matching editor theme. Selected pills are an inky fill with a bold off-white outline, like a comic panel border, through new chip tokens; light keeps its ink-filled chips. The app follows the system theme by default, so with Windows in light mode it shows light until the moon is chosen.
- **Not closed, and why:** a workspace-level API key was considered and left out, since a key per member is what makes each person's agent spend visible and capped (design §13.5). Hosting and deployment, an extension ecosystem, mobile apps and proof with real users at scale are beyond a project change.
- **Two slips, recorded:** twice a `sed` meant to strip stray escape characters from appended text instead put a backtick at the start of every line of this file. The first time it was fixed in a follow-up commit; the second time it was reverted before committing. Appended text is now written from a file, with no substitution afterwards.

## 2026-11-22: Keys for other model providers

Sarthak asked that members can bring keys for providers other than Anthropic.

- **Which providers:** Anthropic, OpenAI, Google Gemini and OpenRouter, one key of each per member. The three new ones all serve the OpenAI Chat Completions API with tool calling (Gemini has an OpenAI-compatible endpoint), so one adapter covers them. OpenRouter adds Llama, Mistral, DeepSeek, Qwen and many others behind one key. An arbitrary base URL was left out on purpose: the runner would send a member's key, and requests, to any address a member typed, including addresses inside the deployment's network.
- **A provider layer in the runner.** The turn loop no longer speaks the Claude API directly. It talks to a `Conversation` that owns its provider's message format, and the loop itself, with its tools, approvals, guidance, revert and cost cap, is unchanged. The Claude adapter sends exactly what it sent before. The other adapter streams, so a long response never meets a request timeout, and sends no Claude-only settings (effort, thinking, task budgets, fallbacks). Gemini rejects `additionalProperties` in tool schemas, so it is stripped for Gemini; tool inputs are still validated against the full schemas before they run. Errors are reported by provider name, and a rejected key still puts a session up for takeover. Gemini answers a bad key with 400 rather than 401, which is handled.
- **Models.** Claude models keep their plain names; others are `openai:<model>`, `gemini:<model>` and `openrouter:<vendor>/<model>`. A web search for current OpenAI and Gemini model names and prices found only third-party pages that disagreed with each other, so none are built in. Members choose "Another model…" and type the provider's model ID, and operators can list models in `AGENT_MODELS` or turn custom models off (`AGENT_CUSTOM_MODELS=false`). Claude models stay limited to the list. Only models the member holds a key for are offered. A turn started without a model (a comment sent to the agent, a takeover) uses the first listed model the member can pay for, or else their latest one.
- **Cost caps stay safe without a price list.** OpenRouter reports each request's real price, which is used. Other models are priced from `AGENT_MODEL_PRICES` when the operator sets it; otherwise they are charged at $15 in and $75 out per million tokens, above any flagship's list price, so a cap can only be reached early, never late. If a provider sends no token counts, they are estimated high from the text.
- **Storage:** `V16` widens the provider check. Each key is still sealed with the member and provider bound into the ciphertext, so a key cannot be moved to another member or provider. An OpenAI key must start with `sk-`, and Anthropic or OpenRouter keys are refused there with a pointer to the right provider. Redaction in transcripts now covers every `sk-` key and Google `AIza` keys.
- **Tests:** runner tests drive a full OpenAI-format turn (read, edit, tool-result pairing), Gemini schema stripping, OpenRouter pricing, key rejection, refusal and the cost cap against the fake model, which now also serves `/v1/chat/completions`. An API test covers per-provider keys, validation, the listing, choosing an OpenAI model without an Anthropic key, and the default model. A new end-to-end test saves an OpenAI key in the browser, names a model and watches the agent edit the file. Docker Desktop stopped during this work, so the end-to-end suite ran in CI rather than locally.
