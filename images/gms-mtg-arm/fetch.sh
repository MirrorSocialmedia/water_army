#!/usr/bin/env bash
# L3-C' arm-translator inputs — ensure the two pinned zips exist and match the
# recorded hashes (pins + provenance: vendor/arm-translator/SOURCE.md).
# Idempotent; network only when files are missing.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
V="$ROOT/vendor/arm-translator"
mkdir -p "$V"
fetch() { # file url sha256
  local f="$V/$1" url="$2" want="$3"
  if [ -f "$f" ] && printf '%s  %s\n' "$want" "$f" | sha256sum --check --status 2>/dev/null; then
    echo "[arm-fetch] present+verified: $1"; return 0
  fi
  echo "[arm-fetch] downloading $1"
  curl -sSL --fail -m 600 -o "$f" "$url"
  printf '%s  %s\n' "$want" "$f" | sha256sum --check
}
fetch libhoudini-0c149b1.zip \
  "https://github.com/rote66/vendor_intel_proprietary_houdini/archive/0c149b1e14d7bfd4b2af261afc6f2e80517dbd98.zip" \
  "41dd445b489549692a2b874b31f0c6b7c5c94547d7c9eca467b8f5794a78706e"
fetch libhoudini-hack-a2194c5.zip \
  "https://github.com/rote66/redroid_libhoudini_hack/archive/a2194c5e294cbbfdfe87e51eb9eddb4c3621d8c3.zip" \
  "5c904d6db5e15adc37ffadde5f21437ccabf86c1e94a3a0e4f77371a90776983"
echo "[arm-fetch] all inputs verified"
