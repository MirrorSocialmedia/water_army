#!/usr/bin/env bash
# WA-FIXALL S6 image build entry — gms-mtg-oemprop-stealth5 (stealth4-next bundle).
# COPY-only build, pins fail closed, post-build IN-IMAGE asserts (no boot).
# The webview APK is NOT committed (262 MB — gitignored vendor/*.apk);
# vendor/SOURCE-PIN.md records URL + sha256 + fetch date. Fails if the
# vendored APK is missing or drifted from the pin.
# Usage: bash images/gms-mtg-oemprop-stealth5/build.sh [final-tag]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FINAL="${1:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth5}"
BASE_TAG="water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth4"
note() { printf '[stealth5-build] %s\n' "$*"; }

BASE_WANT="sha256:92c1922efef6" # stealth4 (WA-FIXALL S2 ship, live image id; S2-RESULTS quotes the manifest digest 8ec65a4d2125)
BASE_GOT="$(docker image inspect -f '{{.Id}}' "$BASE_TAG")"
case "$BASE_GOT" in "$BASE_WANT"*) note "base pin OK: $BASE_TAG @ ${BASE_GOT:0:19}" ;; *) echo "BASE PIN MISMATCH: $BASE_TAG = $BASE_GOT (want ${BASE_WANT}*)" >&2; exit 1 ;; esac

# ---- 0) vendored APK pin ----------------------------------------------------
WV_SHA_WANT="e8d07d54142686ea4452386120961ca32f14c350b9711562c3770cbea577d9ed"
WV_APK="$DIR/vendor/webview-1560807847-arm64.apk"
[ -f "$WV_APK" ] || { echo "missing vendor/webview-1560807847-arm64.apk (see vendor/SOURCE-PIN.md)" >&2; exit 1; }
WV_SHA_GOT="$(sha256sum "$WV_APK" | cut -d' ' -f1)"
[ "$WV_SHA_GOT" = "$WV_SHA_WANT" ] || { echo "WEBVIEW APK DRIFT: $WV_SHA_GOT (want $WV_SHA_WANT)" >&2; exit 1; }
note "apk pin OK: webview ${WV_SHA_GOT:0:12}"

# ---- 1) build.prop must differ from the extracted original by exactly the
#         ro.debuggable line (nothing else silently drifted). -----------------
DIFF_LINES="$(diff "$DIR/vendor/build.prop.orig" "$DIR/files/system/build.prop" | grep -cE '^[<>]' || true)"
[ "${DIFF_LINES:-0}" = "2" ] || { echo "BUILD.PROP DIFF must be exactly the ro.debuggable pair, got:
$(diff "$DIR/vendor/build.prop.orig" "$DIR/files/system/build.prop" | head -6)" >&2; exit 1; }
grep -q '^ro.debuggable=0$' "$DIR/files/system/build.prop" || { echo "build.prop: ro.debuggable=0 missing" >&2; exit 1; }
grep -q '^ro.debuggable=1$' "$DIR/vendor/build.prop.orig" || { echo "build.prop.orig: extracted base must carry ro.debuggable=1" >&2; exit 1; }
note "build.prop pin OK (single ro.debuggable 1->0 change)"

# ---- 2) build ---------------------------------------------------------------
docker build -f "$DIR/Dockerfile" -t "$FINAL" "$ROOT"
note "built: $FINAL"

# ---- 3) post-build assertions (no boot) --------------------------------------
docker create --name stealth5-assert "$FINAL" true >/dev/null
TMPW="/tmp/stealth5-wh.$$"
mkdir -p "$TMPW"
trap 'docker rm -f stealth5-assert >/dev/null 2>&1 || true; rm -rf "$TMPW"' EXIT
docker cp "stealth5-assert:/system/product/app/webview/webview.apk" /tmp/stealth5-webview.apk
cmp -s /tmp/stealth5-webview.apk "$WV_APK" || { echo "ASSERT: in-image webview.apk != vendored apk" >&2; exit 1; }
for f in /system/build.prop /vendor/etc/init/stealth5-extras.rc; do
  docker cp "stealth5-assert:$f" "/tmp/stealth5-$(basename "$f")" || { echo "ASSERT: missing $f in image" >&2; exit 1; }
  cmp -s "/tmp/stealth5-$(basename "$f")" "$DIR/files${f}" || { echo "ASSERT: in-image $f != committed file" >&2; exit 1; }
done
docker cp "stealth5-assert:/vendor/etc/health-fake/battery/health" /tmp/stealth5-psy-health >/dev/null
[ "$(cat /tmp/stealth5-psy-health)" = "Good" ] || { echo "ASSERT: fake psy health file wrong" >&2; exit 1; }
# whiteout effect on the merged view (overlayfs), without booting. The image
# has no usable static exec surface, so the probe is `docker cp` from a
# created container: cp failing with "Could not find the file" = the path is
# whiteouted out of the merged view (and the .wh.su is NOT a literal file).
for gone in /system/xbin/su /system/product/app/webview/oat /system/xbin/.wh.su; do
  docker cp "stealth5-assert:$gone" "$TMPW/whprobe" 2>"$TMPW/whprobe.err" && { echo "ASSERT: $gone still present in merged view (whiteout failed)" >&2; exit 1; }
  grep -q "Could not find the file" "$TMPW/whprobe.err" || { echo "ASSERT: unexpected cp error for $gone: $(cat "$TMPW/whprobe.err")" >&2; exit 1; }
done
docker rm -f stealth5-assert >/dev/null 2>&1 || true
trap - EXIT
note "post-build asserts OK (webview bytes identical to pin; build.prop/rc/psy present; whiteouts effective)"
note "DONE: $FINAL ($(docker image inspect -f '{{.Id}}' "$FINAL"))"
