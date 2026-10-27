# oem-propctl provenance (W1b, 2026-10-27)

| Item | Value |
|---|---|
| Binary | `vendor/oem-propctl-x86_64` → baked as `/vendor/bin/oem-propctl-real` |
| Project | resetprop-rs — `https://github.com/Enginex0/resetprop-rs` |
| Release | v0.6.0 (tag `v0.6.0`, published 2026-06-18, CI-built via github-actions) |
| Asset | `resetprop-x86_64` (496,600 bytes) |
| SHA-256 | `ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b` |
| ELF | x86-64 PIE, Android (interpreter `/system/bin/linker64`), NEEDED = `libc.so libdl.so` only (stock bionic — no Magisk-forked symbols) |
| URL | `https://github.com/Enginex0/resetprop-rs/releases/download/v0.6.0/resetprop-x86_64` |
| Fetched | 2026-10-27 by CTO (W1b code segment), checksummed at fetch, vendored into git |

## Why this source (decision trail)

1. **Magisk's own `resetprop` is not extractable**: since the Magisk 2x merges it
   lives inside `libmagisk.so`/the `magisk` binary (applet), not as a standalone
   file — verified by unpacking release APKs v26.4/v27.0/v28.1/v31.1 (none
   contain a `resetprop` binary; asset inventory of the 31.1 APK: `magisk`,
   `magiskboot`, `magiskinit`, `magiskpolicy`, `init-ld`, …).
2. **resetprop-rs** reimplements the Android property-area format in pure Rust
   (works on stock Android 10+, incl. the Android 14+ `appcompat_override`
   dual-write), ships per-ABI CI-built static-pie assets, no Magisk dependency.
   It also auto-detects and patches the property trie; 165 upstream unit tests
   against synthetic areas.
3. Vendored (not fetched at build time): build reproducibility is a security
   property here — GitHub release assets are mutable, the committed sha256 +
   git blob is the immutable record. Re-fetch flow: `fetch-propctl.sh`
   re-downloads, re-verifies, and any change lands as a reviewed diff.

## Naming (ADR-028 naming audit)

- **Not named `resetprop`** — upstream warns Magisk/KernelSU shadow bare
  `resetprop` via their applet PATHs; full-path + distinct name chosen.
- `oem-propctl` carries no water_army signature (`wa_*` prefix retired —
  `/proc/cmdline` world-readable correlation risk; same ADR section).
- The wrapper (`propctl-wrapper.c`, built at image build time from committed
  source) exists because the carrier cannot carry spaces (real models do —
  "Pixel 8 Pro") and no shell exists at early-init; it decodes `%20`→space,
  fails closed on stray `%`, then `execv`s this binary.

## Build record (2026-10-27, CTO code segment — `docker build` only, no boot)

| Item | Value |
|---|---|
| Image tag | `water-army/redroid:14.0.0-240527-w1b` |
| Image ID | `sha256:100ba08ac6cd63ba7e91bfb3994d045a793d7b7e80bc50f1cd93a6eb07761780` |
| Total size | 874,015,760 bytes (base layers shared; delta layers ≈ 512KB + 971KB + 20.5KB) |
| Wrapper binary | `/vendor/bin/oem-propctl` 956,312 B, sha256 `b1abf8a8a18cf72bdf942130f4e6abfbde3bf312bf572fcee42afb003ce696a6` (built in-image from committed `propctl-wrapper.c`, `gcc:13-bookworm` stage, `gcc -O2 -static`) |
| Baked modes | verified via `docker export`: 0755 / 0755 / 0644, root-owned |
| Base image | `redroid/redroid:14.0.0-240527` = `sha256:a3e654caad74faed03cd5ead057a989e06f507778cda678e5d3b9772e0092f1c` |
| Build note | stock redroid image has **no /bin/sh** — no RUN layer possible (Dockerfile uses COPY + context modes only); wrapper stage rebuilt 2026-10-27 after `-Wformat` cleanup |

### Reproducibility rebuild (2026-10-27 12:21, relay CTO — docker build + export, no boot)

| Item | Value |
|---|---|
| Image ID (rebuild) | `sha256:9b0c697c310689c094698fffad8b168b4e43fed5d596afd256c22b81211add33` (tag moved to this ID) |
| Wrapper binary | sha256 `d7bb0779cc6599be44b722c0fec870bda9f64f0380ebe00f07b20710444403ee`, 956,312 B — **NOT bit-identical** to `b1abf8a8…` above: `gcc:13-bookworm` is a moving tag; point-release drift changes code/build-id. Byte-pin the wrapper only if R0 demands it (build in a sha-pinned gcc image). Functional equivalence: `test/test-mapping.sh` GREEN (real compile + decode/fail-closed matrix). |
| Real binary (baked) | sha256 `ea647e1b…` — bit-identical to vendored `vendor/oem-propctl-x86_64` ✓ (COPY-only, pinned file) |
| Baked modes (export) | `oem-propctl` 0755 / `oem-propctl-real` **0775** / `oem-ro-map.rc` **0664** — group-write bits come from working-tree fs (git tracks exec-bit only); functionally irrelevant inside the container (init runs as root), recorded honestly. Earlier 0755/0755/0644 row reflects that build's context files. |
| rc baked vs repo | sha256 match (`c8c6df15…`) ✓ no drift |


## Real-device verification (deferred — code segment cannot boot)

- [ ] `oem-propctl ro.test hello%20world` → `getprop ro.test` = `hello world` (wrapper decode)
- [ ] overwrite of an existing `ro.build.*` prop succeeds (property-area write semantics)
- [ ] post-boot `getprop` for all 9 mapped props equals the injected carriers (probe app)
- [ ] SELinux: exec from init early-init context permitted under redroid's posture
