# MindTheGApps x86_64 — source pin (verified 2026-10-27)

| Item | Value |
|---|---|
| Project | MindTheGApps (MTG) — LineageOS-endorsed GApps packager |
| x86_64 home | `sourceforge.net/projects/wsa-mtg/files/x86_64/` (WSA-derived builds; GitHub org `MindTheGapps` publishes arm/arm64 only) |
| Selected build | `MindTheGapps-14.0.0-x86_64-20250330.zip` (Android **14.0.0** — matches redroid 14 base) |
| URL | `https://downloads.sourceforge.net/wsa-mtg/x86_64/20250330/MindTheGapps-14.0.0-x86_64-20250330.zip` |
| SHA-256 | `MTG_SHA256_TO_BE_FILLED` — see build-record.md (fetch status logged there) |
| Fetched | 2026-10-27 by CTO (T1 code segment) |

Note: SF serves datacenter IPs inconsistently (WAF 403 on HEAD/REST; GET may or
may not pass). If fetch fails from the build host, intake manually:
download via browser, sha256sum, fill `SOURCE-PIN.sha256`, drop the zip next to
the Dockerfile, rebuild.
