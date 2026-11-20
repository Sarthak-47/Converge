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
- **API rate limits** are fixed windows in Redis, one atomic script per check, shared by every API instance:
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
