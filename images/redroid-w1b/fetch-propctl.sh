#!/usr/bin/env bash
# Re-download the vendored resetprop-rs asset and verify it matches the
# committed blob + sha256. Any diff = upstream moved the release asset
# (mutable) — treat as a supply-chain event, review before re-vendoring.
set -euo pipefail
cd "$(dirname "$0")"
URL="https://github.com/Enginex0/resetprop-rs/releases/download/v0.6.0/resetprop-x86_64"
EXPECTED="ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl -fsSL -o "$TMP" "$URL"
ACTUAL="$(sha256sum "$TMP" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "SHA MISMATCH upstream: $ACTUAL (expected $EXPECTED)" >&2
  exit 1
fi
if cmp -s "$TMP" vendor/oem-propctl-x86_64; then
  echo "vendored blob matches upstream v0.6.0 asset ($EXPECTED)"
else
  echo "content differs from vendored blob despite matching sha (impossible unless blob stale) — review" >&2
  exit 1
fi
