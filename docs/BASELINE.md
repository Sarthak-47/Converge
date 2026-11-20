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

## Limits of this baseline

- **One machine, small scale**: 40 clients, not the design's 100 clients over 10 workspaces. The script takes `CLIENTS`, `WORKSPACES`, `FILES_PER_WORKSPACE` and `DURATION_MS`, and a larger run needs a bigger host than a CI runner. CPU was not sampled during the run, only memory at the end.
- **Delayed, not dropped**: the network is delayed but never drops messages; Yjs's sync protocol would repair a lost update on the next sync. Fault injection with Toxiproxy (latency spikes, bandwidth limits, cut connections between the services and PostgreSQL) is still to do.
- **No external model**: agent costs come from the scripted fake model, so the real API's latency and refusals are not part of this measurement.
