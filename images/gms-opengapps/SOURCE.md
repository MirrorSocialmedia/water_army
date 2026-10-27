# OpenGApps x86_64 variant — SOURCE STATUS: STALLED (verified 2026-10-27)

## Facts (verified via GitHub API + SourceForge listing, 2026-10-27)

| Item | Value |
|---|---|
| GitHub repo | `github.com/opengapps/x86_64` — latest release tag `20220503` (3 May 2022) |
| SourceForge | `sourceforge.net/projects/opengapps/files/x86_64/` — latest folder `20220503`, no newer |
| Max Android version | **12.1 (12L)** — NO Android 13/14 builds were ever produced for x86_64 |
| Zip naming | `open_gapps-x86_64-<android>-pico-<date>.zip` (e.g. `open_gapps-x86_64-12.1-pico-20220503.zip`) |
| SHA-256 | NOT fetchable from this host at build time (SourceForge WAF 403 — see "Fetch" below). Expected file: `open_gapps-x86_64-12.1-pico-20220503.zip`, pinned sha256 recorded manually on first successful fetch (manual intake, see below). |

## Consequence for T1 (honest risk, carried into docs/gms-variants.md)

- Picking OpenGApps for a **redroid 14** base means GmsCore/GmsServices frozen at
  May-2022 versions (Android 11/12.1 era). Modern Gmail & WhatsApp declare
  `minServiceVersion` against newer GMS; 2022-era services are likely to be
  *rejected or force-update-loop* (Google Play Services on a device without a
  working self-update channel cannot self-heal). This variant is kept as the
  "known-bad baseline / control arm", NOT as a PoC front-runner.
- The pico package itself is also **not certification-bearing** (self-extracted
  binaries, no Play Provisioning via this route).

## Fetch (manual intake path — SF WAF blocks datacenter IPs)

From a residential/browser egress:
1. `https://downloads.sourceforge.net/project/opengapps/x86_64/20220503/open_gapps-x86_64-12.1-pico-20220503.zip`
2. `sha256sum` it, fill the digest into `Dockerfile` + `SOURCE-PIN.sha256`.
3. `docker build -t water-army/redroid:14.0.0-240527-gapps-og images/gms-opengapps`

Alternative source if SF is unreachable: the OpenGApps mirror at archive.org
(items tagged opengapps) — verify against the recorded sha256 before use.
