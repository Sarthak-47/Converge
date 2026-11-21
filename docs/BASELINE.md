# Converge baseline

The Phase 13 exit report (design §19): p95 latency, recovery numbers and cost per agent turn. It was produced by `tests/load/baseline.mjs` against the full Compose stack in CI ([run 44754384800](https://github.com/Sarthak-47/Converge/actions/runs/44754384800), 2026-11-20). The raw numbers are in that run's `baseline` artifact. Every CI run repeats the measurement and publishes it as the job summary, so regressions show up run to run.

## Scenario

- **Clients**: 40 real Yjs clients on 8 files in 4 workspaces, 5 clients per file. Each joins through nginx exactly as a browser does: a single-use ticket and an `Origin` header.
- **Typing**: each client inserts a timestamped marker at a random position about every 700 ms (between 350 and 1050 ms), for 60 seconds.
- **Network**: every message a client sends is delayed by a random 50–300 ms.
- **Disturbance**: 10% of the clients drop and reopen their connection a third of the way in. The collaboration service is then restarted (`docker compose restart collab`) while everyone keeps typing.
- **Measuring**: the clients run in one process, so sender and receiver share a clock. Propagation is measured from the moment the sender types to the moment each peer first sees the marker.
- **Machine**: a standard GitHub-hosted Ubuntu runner, with the whole stack on the same machine.

## Results

| Measure | Result |
|---|---|
| Initial sync of all 40 clients | 414 ms |
| Update propagation p50 / p95 / p99 | **176 / 289 / 299 ms** |
| Update propagation, worst case | 2 299 ms (during the collaboration service restart) |
| Updates delivered | 14 576 of 14 576 expected (3 644 updates × 4 peers): **none lost** |
| Reconnect recovery p50 / p95 | 189 / 192 ms (4 clients) |
| Recovery after restarting the collaboration service | **2.0 s** until every client had synced again |
| Convergence after typing stopped | all replicas identical within **0.5 s** |
| Cost per agent turn | **$0.032** (scripted turn, see below) |
| Resident memory at the end | collab 73 MiB, API 418 MiB, nginx 6 MiB |

## What the numbers mean

- **Latency is the network, not the server.** The artificial send delay is uniform between 50 and 300 ms, so on its own it has a median of 175 ms and a p95 of about 288 ms. Measured propagation is 176 ms at the median and 289 ms at p95. Relaying through the collaboration service therefore adds about a millisecond at this load; real network distance, not processing, will dominate what people feel.
- **Nothing was lost through the restart.** Clients queued their edits while the collaboration service was down, reconnected with fresh tickets, and resynced. Every marker reached every peer, and the replicas converged. The 2.3 s worst case is an edit made during the outage. The 2.0 s recovery includes the container restart itself and the provider's reconnect backoff.
- **Reconnects are cheap.** A client that drops and reconnects is back in sync in under 200 ms. That covers a new ticket, the handshake and the sync exchange.
- **Cost per turn** comes from the API's ledger, priced at Claude Opus 5.5 rates ($4 / $20 per million input / output tokens). Each response of the scripted model reports 1 000 input and 200 output tokens. A turn of three tool calls plus a final reply is four responses: 4 × (1 000 × $4 + 200 × $20) / 10⁶ = $0.032. The ledger matched this exactly, as design §22.7 requires. Real turns will differ: they carry the system prompt, the tool definitions and growing context, but also benefit from prompt caching. `agent_turn_cost_micros` and `agent_cache_hit_ratio` on the API's metrics endpoint measure real turns once a member uses their own key.

## Cost of span export (2026-11-22)

Span export (`OTEL_EXPORTER_OTLP_ENDPOINT`, see the README) records a span on every API request. To check that it costs nothing measurable, an authenticated `GET /api/v1/workspaces` was timed 2 000 times in a row through nginx, after 200 warm-up requests, on the local stack, twice with export to Jaeger on and twice with it off. Rerun it with `node tests/load/api-latency.mjs`.

| Span export | p50 | p95 | p99 |
|---|---|---|---|
| On (run 1 / run 2) | 3.79 / 3.25 ms | 6.29 / 7.08 ms | 15.2 / 18.7 ms |
| Off (run 1 / run 2) | 3.95 / 3.47 ms | 6.83 / 7.28 ms | 20.7 / 17.9 ms |

The difference between on and off is smaller than the difference between two runs of the same setting. Spans are queued in memory and sent from a background thread, so a request never waits for the backend.

## Limits of this baseline

- **One machine, small scale**: 40 clients per push in CI; the design's 100 clients over 10 workspaces run by hand (see above). The script takes `CLIENTS`, `WORKSPACES`, `FILES_PER_WORKSPACE` and `DURATION_MS`, and a larger run needs a bigger host than a CI runner. CPU was not sampled during the run, only memory at the end.
- **Delayed, not dropped**: the network is delayed but never drops messages; Yjs's sync protocol would repair a lost update on the next sync. Cut and slowed connections between services are measured separately, under **Fault injection** below.
- **No external model**: agent costs come from the scripted fake model, so the real API's latency and refusals are not part of this measurement.

## The design's full scenario

The `Load and chaos run` workflow (`.github/workflows/load.yml`, started by hand) runs the design's scenario on a GitHub runner: 100 clients on 20 files in 10 workspaces, 180 s of typing at one edit every ~700 ms per client, 50 to 300 ms artificial send delay, and the collaboration service restarted mid-run. Results from 2026-11-21 (main at f69541a):

| Measure | Result |
|---|---|
| Initial sync of all clients | 793 ms |
| Update propagation p50 / p95 / p99 / max | 177 / 288 / 299 / 2487 ms (107 940 samples) |
| Updates delivered to peers | all 107 940 (ratio 1) |
| Reconnect recovery p50 / p95 (10 clients) | 305 / 322 ms |
| Recovery after restarting the collaboration service | 2.1 s |
| Converged after typing stopped | yes, within 541 ms |
| Memory at the end | collab 107 MiB, API 367 MiB, nginx 9 MiB |

Propagation is still the artificial delay, not the server: p50 and p95 match the delay's own distribution, as in the 40-client run, so going from 40 to 100 clients added no measurable latency. The 2.5 s maximum falls inside the restart window.

**Rerun on 2026-11-22** ([run 44948756038](https://github.com/Sarthak-47/Converge/actions/runs/44948756038), main at 5b3de10), after the day's changes to sessions, desktop sync, Git and tracing:

| Measure | 2026-11-21 | 2026-11-22 |
|---|---|---|
| Initial sync of all clients | 793 ms | 1 135 ms |
| Update propagation p50 / p95 / p99 / max | 177 / 288 / 299 / 2 487 ms | 176 / 289 / 300 / 2 553 ms |
| Updates delivered to peers | all 107 940 | all 112 232 |
| Reconnect recovery p50 / p95 | 305 / 322 ms | 286 / 340 ms |
| Recovery after restarting the collaboration service | 2.1 s | 2.2 s |
| Converged after typing stopped | within 541 ms | within 549 ms |
| Memory at the end (collab / API / nginx) | 107 / 367 / 9 MiB | 110 / 397 / 8 MiB |

Everything that measures the service under load is unchanged: propagation still matches the artificial delay, nothing was lost, and recovery is within a tenth of a second. The higher initial sync is one measurement per run, taken while 100 clients connect at once on a shared runner, so it varies from run to run. The workflow runs without span export; its cost was measured separately (see "Cost of span export" below).

## Fault injection

`tests/chaos/faults.mjs` runs in its own CI job with the `chaos` Compose profile, which routes the collaboration service's database connection and the API's calls to the collaboration service through Toxiproxy. Two people type into one file in each scenario. Results from the CI run on 2026-11-20 (commit c8f6c0e):

| Scenario | Result |
|---|---|
| Database 400 ms slower (±100 ms jitter) while typing | Both replicas converged at once; everything was stored 2.1 s later |
| Database unreachable for about 8 s while typing | Replicas kept converging while it was down; everything was stored 2.0 s after it returned |
| API cannot reach the collaboration service | An external write answered 503 after 25 ms and changed nothing; writes worked again 35 ms after the fault cleared |

The first version of this job found two real faults, both fixed before these numbers were taken. An idle database connection dropped by the database crashed the collaboration service (the pg pool's `error` event had no listener). And edits made while the database was down were never stored once it returned, because Hocuspocus stores again only on the next change; failed stores are now retried with backoff while the document stays loaded.
