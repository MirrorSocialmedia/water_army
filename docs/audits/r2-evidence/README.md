# R2 spike raw evidence (copied from `/tmp/r2-net/`, 2026-10-20 07:48 HKT)

Preserved to protect against `/tmp` loss. All mock jsonl + per-test evidence
from the gen1 spike run against `redroid-matrix-r2-spike` (R1 image,
tun2socks v2.7.0 pinned, ADB 127.0.0.1:16002, device 172.17.0.3).

**Timezone note**: jsonl/evidence timestamps are **UTC (ISO Z)**. HKT = UTC+8.
Test window = 2026-10-19 20:02–21:00 UTC = 2026-10-20 04:02–05:00 HKT.

## Layout

| dir/file | contents |
|---|---|
| `evidence/*.txt` | per-test raw output captured by `scripts/wa-r2-dataspike.mjs` (L1–L6) |
| `evidence/results.json` → `results-l6.json` | L6 driver verdicts (a–h) |
| `mocks/*.jsonl` | mock流水：socks5 relay (20082), reject (20083), hang (20084), rst (20085), echo (20271), echo-hang (20273), echo-rst (20274) |
| `mocks/*.out` | mock stdout (listen lines) |
| `captures/` | key binary captures: `pay-*` = exact request bytes pushed to device; `out-*` = device-side captured response; `out-*-zero.bin` = 0-byte captures (device received NOTHING — pulled OK, empty) |
| `captures/out-l1b.bin` | 264B direct-path response (L1b PASS capture) |
| `captures/out-selftest.bin` | 271B mock-chain self-test response |

## Key findings encoded in this data

1. **L4/L5 shape (fwd-dir dead)** — `mocks/socks5.jsonl` lines for
   `from=172.17.0.3:*` (device flows): every flow = `tcp-connect` followed by
   `tcp-close bytesIn=0 bytesOut=51 why=upstream-close` exactly **60.0s** later
   (= Node `headersTimeout`). `bytesOut:51` = Node auto
   `HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n` (51 bytes; the
   device captured 49B of it in the pre-fix probe run — recorded in
   `../tcp-transport-investigation.md` §3; the raw 49B file was overwritten by
   the post-fix clean re-runs, hence `captures/out-l4-zero.bin` = 0B).
2. **L6 close-flush anomaly (state-dependent teardown flush)** — the 2 L6b
   parallel flows `:44454` / `:44468` closed at **20:47:25.347Z** with
   `bytesIn=663` (their FULL 663B request, matching `captures/pay-l6a0.bin`
   size) — at the same millisecond the sequential flow `:44456` closed with
   `bytesIn=0`. Two `relay-error "ended by the other party"` lines correlate
   exactly with the two 663B flows. → gVisor buffers fwd data (never ACKs /
   forwards mid-flow) and **sometimes** force-flushes it to the relay at
   session teardown. This is the same shape as Stage B M5(a) `bytesIn:56` and
   R0 test #3 `bytesIn:93` (both observed at close).
3. **Orphan session `:42624`** — connected 20:29:09Z (L4 clean re-run era,
   buggy-probe 60s+ read), closed 20:47:25Z in the same millisecond batch as
   the L6b/L6d closes, `bytesIn=0 bytesOut=51 why=upstream-close`. Survived
   the t2s re-provision cycle (L6e/f/g) while the relay-side flow stayed open;
   mock-side event timing for this orphan is not further instrumented —
   recorded as observation, no mechanistic claim.
4. **L6g PASS (control plane)** — `mocks/socks5-reject.jsonl`
   `tcp-reject-connect` 20:48:19.528Z; device probe got
   `RC=read-error DETAIL=Connection reset by peer T_TOTAL_MS=2` — proxy
   rejection propagates to device within 2ms.
5. **L6e/L6f fwd-dir invisible to server** — `mocks/echo-hang.jsonl` and
   `mocks/echo-rst.jsonl` have **no** entry for the L6e/L6f tunnel flows
   (their only entries are gen1 manual host-side tests at 20:29:00Z / none)
   → fwd data never reached the hang/rst endpoints.
6. **P3 mock fidelity (FIDEL)** — `mocks/socks5.jsonl` tail lines
   `from=127.0.0.1:*` (host-side self-tests, NOT through gVisor): gen1
   20:58/20:59Z + gen2 re-verify 23:47Z: `bytesIn=666/668 bytesOut=272/274`
   with exact sha256 match in `mocks/echo.jsonl` (`/r2-selftest`,
   `/r2-selftest2`) — the mock relay handles CONNECT + coalesced
   CONNECT+payload burst with zero loss. Mock chain excluded as fault.

## Provenance

- Device-side runs: production script bytes from `apps/api/src/services/redroid-service.js`
  (buildT2sStageScript/buildTunnelSetupScript/buildT2sRunScript), root via
  `docker exec` (production geometry). Binary sha256 = R1 pin.
- Driver: `scripts/wa-r2-dataspike.mjs`; probe: `tests/tools/probe.c`
  (post-fix: sigaction w/o SA_RESTART, SO_LINGER{on,0} RST close, 15s
  send-window alarm).
- Spike deviation (documented): binary was `docker export`ed from the image
  layer and `adb push`ed for the data-plane spike (fresh `/data` volume
  shadows the baked path — see investigation doc §7 / R1-gap fix commit).
