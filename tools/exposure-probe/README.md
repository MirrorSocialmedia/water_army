# exposure-probe (T7)

Browser-side + Android-side **collection tools** for the exposure audit
(`docs/exposure-surfaces.md`). Probes REPORT, they do not judge — grading/evidence
grades live in the audit doc.

## a) Web probe — `index.html`

Single-file, zero-dep page. Open in Chrome **on the device** during the real-device
stage (served from the host over the identity egress path or `adb forward`, file://
also works). Collects:

- UA / userAgentData / platform / vendor
- navigator.hardwareConcurrency / deviceMemory / languages / plugins / webdriver (B1/B2/B5)
- screen geometry + dpr + orientation (D7/B6)
- Intl timeZone + locale (S2 — compare against profile DB = injection gap proof)
- WebGL UNMASKED vendor/renderer + extension set (D4/B4 — expect host GPU tell until L2)
- canvas PNG hash + AudioContext peaks hash (B3 — run on N identities: identical
  hashes = fleet homogeneity measured, not assumed)
- WebRTC ICE local IPs (N5 — 172.x / non-phone ranges = Docker leak)
- getBattery (D9), pointer/touch media queries, performance.memory

Output = one JSON (`wa-exposure-probe/1`), Copy/Download buttons. Evidence:
save as `logs/<stage>/exposure-probe-<identity>.json`. Re-run stability check: run
twice per identity — canvas/audio hashes MUST be identical within an identity
(stable-fingerprint semantics) and expected to differ across identities once
randomization exists (currently expected identical = homogeneity baseline).

## b) Android probe extension — `ProbeSurfacesExt.java`

Skeleton (compile inside the device build env — not built here, zero host pollution)
for surfaces `probe-app/` cannot read. Merge target = W1b probe dump as `wa-probe/2`
(additive keys; `probe-assert.mjs` unaffected). Gap list implemented as methods:

| X | Surface | Audit ref |
|---|---------|-----------|
| X1 | full Settings global/system/secure dump | S1 |
| X2 | SensorManager full list (name/type/vendor/power) | D8 |
| X3 | BatteryManager sticky broadcast + /sys/class/power_supply nodes | D9 |
| X4 | StatFs /data + / totals (host-disk tell) | D10 |
| X5 | /proc/meminfo MemTotal, /proc/cpuinfo vendor/model/processors, uname -a | D5/D10/D11 (root cause of web B2) |
| X6 | telephony deep fields (simState/signal/dataNetworkType/roaming) | S6 |
| X7 | full getprop dump (propCount already in W1b probe) | D3 |
| X8 | Bluetooth adapter presence/enabled | S7 |

Control run = same probe on 1 real reference phone (per w1b-l2-l3 §L2-1: diff table
drives L2 scope; no collection, no engineering).
