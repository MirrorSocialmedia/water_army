# microG variant — source pins (verified 2026-10-27)

Upstream: `github.com/microg/GmsCore`, release tag `v0.3.17.252432` (Apache-2.0,
self-signed with microG's own key — NOT Google-signed).

| Asset | Size | SHA-256 | Role |
|---|---|---|---|
| `com.google.android.gms-252432034.apk` | 108,113,833 | recorded in `SOURCE-PIN.sha256` at fetch | GmsCore replacement (maps com.google.android.gms) |
| `com.android.vending-84022634.apk` | 4,210,169 | `9b8616011cc8f026bcbbe094df850794abb9d6d9f23214d7a8f8c4d1033ea012` (fetched 2026-10-27) | "Play Store" UI (microG vending) |

URLs (sha-pinned by tag; GitHub release assets are mutable → digest above is the
immutable record, same discipline as `images/redroid-w1b/propctl.provenance.md`):

- `https://github.com/microg/GmsCore/releases/download/v0.3.17.252432/com.google.android.gms-252432034.apk`
- `https://github.com/microg/GmsCore/releases/download/v0.3.17.252432/com.android.vending-84022634.apk`

Fetch: `./fetch.sh` (checksums at fetch; refuses mismatch).

## WhatsApp compatibility — 待證 (flagged per task brief)

- microG provides GMS API spoofing + FCM (via its own push channel); WhatsApp
  core messaging does NOT require GMS (works on non-GMS phones in CN markets).
  Google-drive chat backup and location-via-GLS features depend on GMS APIs →
  must be validated in the real-device leg (R4). Do not assume.
