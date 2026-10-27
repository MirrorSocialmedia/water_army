# T1-gms build record — microG variant (2026-10-27, CTO code segment)

Docker build only — NO redroid boot (RAM gate closed; boot = real-device leg R1).

| Item | Value |
|---|---|
| Image tag | `water-army/redroid:14.0.0-240527-gms-microg` |
| Image ID / digest | `sha256:08b7be141cf761e22f04af9e8881b602b119a54b9745a7f52a057dce7d1b5c38` |
| Total size | 3.2 GB (base + ≈112 MB APKs) |
| Inputs | `com.google.android.gms-252432034.apk` sha256 `e5e6cba078bdec812b5450599350e5c1a12c8b7438da5bf77123af170f8c1a35` (108,113,833 B); `com.android.vending-84022634.apk` sha256 `9b8616011cc8f026bcbbe094df850794abb9d6d9f23214d7a8f8c4d1033ea012` (4,210,169 B) — both from tag `v0.3.17.252432`, GitHub, fetched + checksummed 2026-10-27 |
| Base | `redroid/redroid:14.0.0-240527` (production pin) |
| Layout | `/product/app/microG-GmsCore/com.google.android.gms.apk`, `/product/app/microG-Vending/com.android.vending.apk` — landed via base partition symlink into `/system/product/app/…` (export-audited ✓) |

Non-privileged `/product/app` placement (see Dockerfile header): avoids
privapp-permissions strict-boot failure class; microG's supported stock-ROM path
is user-install, so this is conservative. If R-step evidence shows privileged
placement is required for self-update/sync, that is a PoC finding to feed the
two-layer merge decision.

vendor/ is gitignored; re-create via `./fetch.sh` (checksum-verified, idempotent).
