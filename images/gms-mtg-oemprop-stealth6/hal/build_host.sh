#!/usr/bin/env bash
# WA-STEALTH6 T2 — build wa-sensors host-side against the base image's own
# runtime libraries (used as *link stubs*: they provide DT_NEEDED + the
# exported-symbol universe). No target sysroot, no network at link time.
#
# Discipline:
#   - link with -Wl,--unresolved-symbols=ignore-all, then ASSERT that every
#     remaining undefined symbol is provided by one of the stub libs (or is
#     in the explicit kernel/bionic whitelist). This catches "we linked but
#     the device can't load it" at build time.
#   - the produced binary is committed to git; build.sh only rebuilds it when
#     sources are newer. Deterministic inputs => we assert, not re-run.
set -euo pipefail
cd "$(dirname "$0")"

BASE_IMAGE="${BASE_IMAGE:-water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth5}"
OUT="../files/vendor/bin/hw/android.hardware.sensors-service.example"
mkdir -p "$(dirname "$OUT")"
STUBS="$(mktemp -d /tmp/wa-sensors-stubs.XXXXXX)"
trap 'rm -rf "$STUBS" "$STUBS.missing"' EXIT

# 1. extract link stubs from the base image (no boot needed; docker cp works
#    on a created-but-never-started container)
CTR=$(docker create "$BASE_IMAGE" true)
pick() { # $1 = path inside image, $2 = local name
  if docker cp "$CTR:$1" "$STUBS/$2" 2>/dev/null; then return 0; fi
  echo "$1" >> "$STUBS.missing"; return 1
}
pick /system/lib64/libbinder_ndk.so                     libbinder_ndk.so
pick /system/lib64/android.hardware.sensors-V2-ndk.so   android.hardware.sensors-V2-ndk.so
pick /system/lib64/android.hardware.common-V2-ndk.so    android.hardware.common-V2-ndk.so
pick /system/lib64/android.hardware.common.fmq-V1-ndk.so android.hardware.common.fmq-V1-ndk.so
# bionic libs ship under /system/apex in the image layers; the runtime
# /apex/com.android.runtime mount is an overlay bind (not image content),
# and /system/lib64/{libc,libm}.so are dangling symlinks inside the image.
pick /system/apex/com.android.runtime/lib64/bionic/libc.so  libc.so
pick /system/apex/com.android.runtime/lib64/bionic/libm.so  libm.so
pick /system/lib64/libc++.so                            libc++.so
pick /system/lib64/liblog.so                            liblog.so
docker rm -f "$CTR" >/dev/null
[ ! -s "$STUBS.missing" ] || { echo "FATAL: missing stub libs:"; cat "$STUBS.missing"; exit 1; }

# 2. link
g++ -std=c++17 -O2 -fPIC -fno-exceptions -fno-rtti -nostdlib -nostartfiles \
    -Wl,-dynamic-linker=/system/bin/linker64 -Wl,-pie \
    -Wl,--unresolved-symbols=ignore-all -Wl,--hash-style=sysv \
    -o "$OUT" wa_sensors_service.cpp \
    "$STUBS"/android.hardware.sensors-V2-ndk.so \
    "$STUBS"/android.hardware.common-V2-ndk.so \
    "$STUBS"/android.hardware.common.fmq-V1-ndk.so \
    "$STUBS"/libbinder_ndk.so "$STUBS"/liblog.so \
    "$STUBS"/libc.so "$STUBS"/libm.so "$STUBS"/libc++.so
chmod 755 "$OUT"

# 3. assertions
# 3a. DT_NEEDED subset check: the linker keeps only libs that resolve symbols
#     (as-needed). Required core set must be present; nothing outside the
#     device stub universe may appear.
cat > /tmp/wa-want.$$ <<'NEEDED'
android.hardware.common.fmq-V1-ndk.so
android.hardware.common-V2-ndk.so
android.hardware.sensors-V2-ndk.so
libc.so
libc++.so
libbinder_ndk.so
libm.so
NEEDED
readelf -d "$OUT" | awk '/NEEDED/ {gsub(/[\[\]]/,"",$NF); print $NF}' | sort > /tmp/wa-needed.$$
comm -13 /tmp/wa-want.$$ /tmp/wa-needed.$$ | grep . && { echo "FATAL: DT_NEEDED outside stub universe"; exit 1; }
for req in android.hardware.sensors-V2-ndk.so libbinder_ndk.so libc++.so libc.so; do
  grep -qx "$req" /tmp/wa-needed.$$ || { echo "FATAL: required DT_NEEDED missing: $req"; exit 1; }
done
rm -f /tmp/wa-needed.$$ /tmp/wa-want.$$

# 3b. every undefined symbol exists in at least one stub lib (whitelist: none
#     expected beyond them; anything unmatched = device would fail to load)
for lib in "$STUBS"/*.so; do
  nm -D --defined-only "$lib" 2>/dev/null | awk '{print $NF}'
done | sed 's/@.*//' | sort -u > "$STUBS/exports"
nm -D --undefined-only "$OUT" | awk '{print $NF}' | sed 's/@.*//' | sort -u > /tmp/wa-undef.$$
comm -23 /tmp/wa-undef.$$ "$STUBS/exports" > /tmp/wa-miss.$$
if [ -s /tmp/wa-miss.$$ ]; then
  echo "FATAL: symbols not provided by device libs:"; cat /tmp/wa-miss.$$
  exit 1
fi
rm -f /tmp/wa-undef.$$ /tmp/wa-miss.$$

# 3c. sanity: entry present, PIE, sane size
[ "$(readelf -h "$OUT" | awk '/Type:/{print $2}')" = "DYN" ] || { echo "FATAL: not PIE"; exit 1; }
nm "$OUT" | grep -q ' T _start' || { echo "FATAL: _start missing"; exit 1; }
SZ=$(stat -c%s "$OUT"); [ "$SZ" -lt 200000 ] || { echo "FATAL: binary bloated ($SZ)"; exit 1; }

echo "OK: $(basename "$OUT") built ($SZ bytes)"
sha256sum "$OUT" | awk '{print $1}'
