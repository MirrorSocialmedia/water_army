# BR-B2 G8 live smoke report
generated: 2026-10-21T11:01:52.585Z | smoke complete

**result: PASS** (40/40 checks, 1 soft)

## Requirement coverage

| G8 req | evidence |
|---|---|
| 1. active never >2 (DB lease count 時間點 + metrics) | lease-sampler.json (150ms resource_lease series, max) + api activeCount peaks in table |
| 2. all 5 identity 到終態 COMPLETED | Phase A identity rows (db-identities.tsv) |
| 3. pause 中途：running 唔 kill、queued 停派 | Phase B rows (incl. zero attempt_started after pause ts) |
| 4. kill -9 → reconciliation 收復、唔雙跑 | Phase C/D rows (EXECUTOR_LOST, retry attempt) + attempt-events.tsv |
| 5. 雙 scheduler 同時 tick 唔重複 enqueue | Phase A idempotency rows (5 rows/5 events/2 schedulers) |

## Checks

| phase | check | result | detail |
|---|---|---|---|
| A | cycle reaches terminal without timeout | PASS | elapsed=9s |
| A | batch COMPLETED | PASS | COMPLETED |
| A | all 5 runs succeeded | PASS | succeeded,succeeded,succeeded,succeeded,succeeded |
| A | api activeCount peak ≤ 2 (cap held — sampled metric) | PASS | peak=2 |
| A | parallelism observed (peak reached 2) | PASS | peak=2 |
| A | identities synced COMPLETED (G8 req 2) | PASS | COMPLETED,COMPLETED,COMPLETED,COMPLETED,COMPLETED |
| A | idempotency: exactly 5 run rows for 5 identities (0 duplicates from 2 schedulers) | PASS | rows=5 |
| A | idempotency: no spurious retries (all attempt=1) | PASS | 1,1,1,1,1 |
| A | idempotency: exactly one attempt_started per run (claim CAS live) | PASS | events=5 perRun=1,1,1,1,1 |
| A | both replicas booted the batch scheduler | PASS | w1=true w2=true |
| A | both replicas consumed jobs (2 live executors) | PASS | w1jobs=3 w2jobs=2 |
| A | P2002 create-race observed (informational — proof the race path fired) | FAIL (soft) | races=0 is also fine (no race window hit) |
| B | pause(stopExisting=false) accepted (202) | PASS | 202 {"batch":{"id":"119e4741-d205-44ba-b8a7-b10363f311a7","name":"smoke B #1","cycleId":"949146eb-e71a-4d5d-a21b-e6d907513a3 |
| B | batch → PAUSED | PASS | PAUSED |
| B | running at pause NOT killed (all finished succeeded) | PASS | runningAtPause=2 → succeeded,succeeded |
| B | queued at pause stopped (settled cancelled/succeeded, none running) | PASS | queuedAtPause=3 → cancelled,cancelled,cancelled |
| B | queued 停派: zero attempt_started after the pause response (hard dispatch-stop proof) | PASS | post-pause events=0 (pause resp ts 2026-10-21T11:00:59.857Z) |
| B | resume accepted (202) | PASS | 202 {"batch":{"id":"119e4741-d205-44ba-b8a7-b10363f311a7","name":"smoke B #1","cycleId":"949146eb-e71a-4d5d-a21b-e6d907513a3 |
| B | resume re-arms + completes: batch COMPLETED, every identity succeeded exactly once | PASS | status=COMPLETED runs=8 succeeded=5 cancelled=3 |
| B | identities synced COMPLETED after resume | PASS | COMPLETED,COMPLETED,COMPLETED,COMPLETED,COMPLETED |
| C | kill -9 on executor W2 executed | PASS |  |
| C | cycle converges after kill (surviving scheduler reconciles) | PASS | status=COMPLETED elapsed=14s |
| C | batch COMPLETED (orphan re-tried to success) | PASS | COMPLETED |
| C | all runs terminal | PASS | succeeded@a1,succeeded@a1,succeeded@a1,succeeded@a2,succeeded@a1 |
| C | exactly one EXECUTOR_LOST, on a run that was running at kill (lease-expiry path, no blind re-run) | PASS | onKilledRuns=1 totalLostEvents=1 |
| C | orphan re-executed as attempt 2 and succeeded | PASS | attempt=2 status=succeeded |
| C | zero live container_slot leases | PASS | leases=0 |
| D | exactly one prior worker alive (other was kill -9 in C) | PASS | alive=1 |
| D | survivor drained cleanly (SIGTERM, no leftover runs) | PASS | liveRuns=0 |
| D | solo worker actually killed mid-run | PASS |  |
| D | full 3-batch cycle reaches terminal after reconcile | PASS | statuses=[COMPLETED,COMPLETED,COMPLETED] elapsed=24s |
| D | all 3 batches COMPLETED | PASS | COMPLETED,COMPLETED,COMPLETED |
| D | orphan run re-executed: attempt=2 succeeded (EXECUTOR_LOST → retry → success) | PASS | attempt=2 status=succeeded |
| D | exactly one EXECUTOR_LOST reconciliation event (deterministic orphan) | PASS | lostEvents=1 |
| D | zero live container_slot leases after reconcile | PASS | leases=0 |
| D | all D identities honestly terminal (COMPLETED) | PASS | COMPLETED,COMPLETED,COMPLETED |
| D | progressCycles live: batch #2/#3 auto-started by scheduler (startedAt > prev finishedAt, no API start call) | PASS | b1→b2=true b2→b3=true |
| G | DB lease sampler: max concurrent container_slot leases ≤ 2 (whole run, 150ms points) | PASS | max=2 samples=415 |
| G | no double execution: exactly one attempt_started per (run, attempt) across ALL phases | PASS | events=20 groups=20 dups=0 |
| G | final state: zero live container_slot leases | PASS | leases=0 |
