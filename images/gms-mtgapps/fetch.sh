#!/usr/bin/env bash
# Fetch + checksum the pinned MTG x86_64 zip (SOURCE-PIN.sha256 is the record).
# SourceForge WAFs datacenter IPs — on failure, intake manually (see SOURCE.md).
set -euo pipefail
cd "$(dirname "$0")"
URL="https://downloads.sourceforge.net/wsa-mtg/x86_64/20250330/MindTheGapps-14.0.0-x86_64-20250330.zip"
OUT="vendor/MindTheGapps-14.0.0-x86_64-20250330.zip"
mkdir -p vendor
if [[ -f "$OUT" ]] && (cd vendor && sha256sum -c ../SOURCE-PIN.sha256 --status); then
  echo "cached: $OUT"; exit 0
fi
curl -fSL --retry 3 --http1.1 -A "Wget/1.21" -o "$OUT" "$URL"
(cd vendor && sha256sum -c ../SOURCE-PIN.sha256)
echo OK
