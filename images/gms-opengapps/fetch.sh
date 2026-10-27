#!/usr/bin/env bash
# OpenGApps intake: SourceForge WAF-blocked from datacenter hosts.
# Manual path: download via browser/residential egress → place in vendor/ →
# sha256sum → fill SOURCE-PIN.sha256 → this script then verifies.
set -euo pipefail
cd "$(dirname "$0")"
OUT="vendor/open_gapps-x86_64-12.1-pico-20220503.zip"
URL="https://downloads.sourceforge.net/project/opengapps/x86_64/20220503/open_gapps-x86_64-12.1-pico-20220503.zip"
mkdir -p vendor
if [[ ! -f "$OUT" ]]; then
  echo "trying direct fetch (likely WAF-blocked) ..."
  curl -fSL --retry 2 --http1.1 -A "Wget/1.21" -o "$OUT" "$URL" || {
    rm -f "$OUT"
    echo "MANUAL INTAKE REQUIRED: see SOURCE.md"
    exit 2
  }
fi
(cd vendor && sha256sum -c ../SOURCE-PIN.sha256)
echo OK
