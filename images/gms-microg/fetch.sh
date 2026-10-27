#!/usr/bin/env bash
# Fetch + checksum microG APKs (pinned release v0.3.17.252432, tag v0.3.17.252432).
# GitHub release assets are MUTABLE — SOURCE-PIN.sha256 is the immutable record.
set -euo pipefail
cd "$(dirname "$0")"
BASE="https://github.com/microg/GmsCore/releases/download/v0.3.17.252432"
mkdir -p vendor
fetch() { # $1=asset name
  local out="vendor/$1"
  if [[ -f "$out" ]] && sha256sum -c <(grep " $1\$" SOURCE-PIN.sha256) --status - 2>/dev/null; then
    echo "cached: $out"; return
  fi
  echo "fetching $1 ..."
  curl -fSL --retry 3 -o "$out" "$BASE/$1"
  sha256sum "$out"
}
fetch com.google.android.gms-252432034.apk
fetch com.android.vending-84022634.apk
echo "== verify against SOURCE-PIN.sha256 =="
(cd vendor && sha256sum -c ../SOURCE-PIN.sha256)
echo OK
