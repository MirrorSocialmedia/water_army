#!/bin/sh
# =============================================================================
# fetch-tun2socks.sh — fetch + verify the PINNED tun2socks release artifact.
#
# The wrapper image (Dockerfile in this directory) is the ONLY intended
# caller:
#     sh fetch-tun2socks.sh /build/t2s
# producing /build/t2s/tun2socks (0755) for the final stage's COPY.
#
# Contract (施工 MD §3.3):
#  - source pinned by docker/redroid-matrix/tun2socks.env (version + sha256);
#    NO floating 'latest' (the script refuses such URLs outright)
#  - retry with a bounded attempt count (default 3)
#  - FAIL FAST on: download failure, unzip failure, missing inner file,
#    sha256 mismatch, non-ELF file, 32-bit ELF, non-x86-64 ELF
#  - the output is 0755 (the final image stage has no /bin/sh, so the mode
#    must be correct before the COPY — COPY preserves it)
#
# POSIX sh (dash-safe): no bashisms.
#
# Env overrides (TEST KNOBS ONLY — production callers rely on the pin file):
#   TUN2SOCKS_PIN_FILE      path to the pin file (default: next to this script)
#   TUN2SOCKS_URL           full URL override (e.g. file:// fixture in tests)
#   TUN2SOCKS_SHA256        expected sha256 override
#   TUN2SOCKS_INNER_FILE    inner file name override
#   TUN2SOCKS_FETCH_RETRIES max download attempts (default 3)
#   TUN2SOCKS_RETRY_SLEEP   seconds between attempts (default 2)
# =============================================================================
set -eu

die() {
    echo "tun2socks-fetch: ERROR: $*" >&2
    exit 1
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PIN_FILE=${TUN2SOCKS_PIN_FILE:-$SCRIPT_DIR/tun2socks.env}
[ -r "$PIN_FILE" ] || die "pin file not readable: $PIN_FILE"
# shellcheck disable=SC1090
. "$PIN_FILE"

[ -n "${TUN2SOCKS_VERSION:-}" ] || die "pin file missing TUN2SOCKS_VERSION"
[ -n "${TUN2SOCKS_ASSET:-}" ] || die "pin file missing TUN2SOCKS_ASSET"
[ -n "${TUN2SOCKS_SHA256:-}" ] || die "pin file missing TUN2SOCKS_SHA256"
[ -n "${TUN2SOCKS_INNER_FILE:-}" ] || die "pin file missing TUN2SOCKS_INNER_FILE"

# sha256 must be exactly 64 lowercase hex chars
case "$TUN2SOCKS_SHA256" in
    *[!0-9a-f]*) die "TUN2SOCKS_SHA256 is not lowercase hex: $TUN2SOCKS_SHA256" ;;
esac
[ ${#TUN2SOCKS_SHA256} -eq 64 ] || die "TUN2SOCKS_SHA256 must be 64 hex chars"

# The URL is derived from the pinned version — one place, no drift.
URL=${TUN2SOCKS_URL:-"https://github.com/xjasonlyu/tun2socks/releases/download/v${TUN2SOCKS_VERSION}/${TUN2SOCKS_ASSET}"}
case "$URL" in
    *latest*) die "refusing floating 'latest' URL: $URL" ;;
esac

DEST=${1:?usage: fetch-tun2socks.sh <dest-dir>}
RETRIES=${TUN2SOCKS_FETCH_RETRIES:-3}
SLEEP_S=${TUN2SOCKS_RETRY_SLEEP:-2}
mkdir -p "$DEST"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/artifact.zip"

# --- bounded retry download --------------------------------------------------
try=1
while :; do
    if curl -fSL --max-time 600 -o "$ZIP" "$URL"; then
        break
    fi
    if [ "$try" -ge "$RETRIES" ]; then
        die "download failed after $RETRIES attempt(s): $URL"
    fi
    try=$((try + 1))
    echo "tun2socks-fetch: attempt $((try - 1))/$RETRIES failed, retrying in ${SLEEP_S}s" >&2
    sleep "$SLEEP_S"
done

# --- unzip (the release asset is a zip containing the bare binary) ----------
unzip -o -j -q "$ZIP" -d "$TMP/extracted" || die "unzip failed (corrupt archive?)"
INNER=$(find "$TMP/extracted" -type f -name "$TUN2SOCKS_INNER_FILE" | head -n 1)
[ -n "$INNER" ] || die "inner file '$TUN2SOCKS_INNER_FILE' not found in archive"

# --- sha256 verification (of the inner binary) -------------------------------
ACTUAL=$(sha256sum "$INNER" | awk '{print $1}')
if [ "$ACTUAL" != "$TUN2SOCKS_SHA256" ]; then
    die "sha256 mismatch: expected $TUN2SOCKS_SHA256 got $ACTUAL"
fi

# --- ELF format check (static x86-64 expected):
#     bytes 0-3  = 7f 45 4c 46 ("ELF")
#     byte  4    = 02 (ELFCLASS64)
#     bytes 18-19= 3e 00 (EM_X86_64, little-endian)
HEX=$(od -An -tx1 -N20 "$INNER" | tr -d ' \n')
[ ${#HEX} -eq 40 ] || die "file too short for an ELF header"
MAGIC=$(printf '%s' "$HEX" | cut -c1-8)
CLASS=$(printf '%s' "$HEX" | cut -c9-10)
MACHINE=$(printf '%s' "$HEX" | cut -c37-40)
[ "$MAGIC" = "7f454c46" ] || die "not an ELF binary (magic=$MAGIC)"
[ "$CLASS" = "02" ] || die "not a 64-bit ELF (class=$CLASS)"
[ "$MACHINE" = "3e00" ] || die "not an x86-64 ELF (e_machine=$MACHINE)"

# --- stage: 0755 (mode must survive into the final image via COPY) -----------
install -m 0755 "$INNER" "$DEST/tun2socks"

echo "tun2socks-fetch: OK version=$TUN2SOCKS_VERSION sha256=$ACTUAL dest=$DEST/tun2socks"
