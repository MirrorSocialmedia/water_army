#!/usr/bin/env bash
# L2 wave-2 (ADR-033) — host contract test for oem-proc-view.sh (NO redroid
# boot): getprop/mount are stubbed via PATH, the render+mount contract of the
# on-device toybox script is asserted with the host shell (POSIX discipline
# holds for both — same reason test-mapping.sh can exercise the wrapper logic).
#
# Usage: bash images/redroid-w1b/test/test-proc-view.sh   (exit 0 = all green)
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/oem-proc-view.sh"
[ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT missing"; exit 1; }

WORK=$(mktemp -d /tmp/proc-view-test.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok   - $*"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $*"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

run_case() { # $1=props-file (may not exist) -> sets RC, exports stubs
  : > "$WORK/mounts.log"
  rm -rf "$WORK/proc"
  export WA_PROPS="$WORK/props.$1"
  export OEM_PROC_TMPDIR="$WORK/proc.$1"
  PATH="$WORK/stub:$PATH" sh "$SCRIPT"
  RC=$?
  OUT_DIR="$WORK/proc.$1"
}

mkstub() {
  mkdir -p "$WORK/stub"
  cat > "$WORK/stub/getprop" <<'EOF'
#!/bin/sh
[ -f "$WA_PROPS" ] || exit 0
grep "^$1 " "$WA_PROPS" 2>/dev/null | head -1 | cut -d' ' -f2-
EOF
  cat > "$WORK/stub/mount" <<'EOF'
#!/bin/sh
echo "$@" >> "$WA_MOUNT_LOG"
exit 0
EOF
  chmod +x "$WORK/stub/getprop" "$WORK/stub/mount"
}
mkstub
export WA_MOUNT_LOG="$WORK/mounts.log"

FULL_CLUSTERS='1:0x41:0xd4e:0x0:0x0:66.66,4:0x41:0xd4d:0x0:0x0:66.66,4:0x41:0xd46:0x0:0x0:66.66'

# ---- case A: full carriers (Pixel 8 Pro story: 9 cores, ~11.06 GiB) ---------
cat > "$WORK/props.A" <<EOF
ro.boot.oem_mem_total_kb 11324620
ro.boot.oem_cpu_cores 9
ro.boot.oem_cpu_clusters $FULL_CLUSTERS
EOF
run_case A
check "A exit 0" '[ $RC -eq 0 ]'
check "A meminfo MemTotal == carrier" \
  '[ "$(awk "/MemTotal:/{print \$2}" "$OUT_DIR/meminfo")" = "11324620" ]'
check "A meminfo kB suffix" 'grep -q " kB$" "$OUT_DIR/meminfo"'
check "A cpuinfo core count == 9" '[ "$(grep -c "^processor" "$OUT_DIR/cpuinfo")" -eq 9 ]'
check "A X3 part id x1" '[ "$(grep -c "CPU part.*0xd4e" "$OUT_DIR/cpuinfo")" -eq 1 ]'
check "A A715 part id x4" '[ "$(grep -c "CPU part.*0xd4d" "$OUT_DIR/cpuinfo")" -eq 4 ]'
check "A A510 part id x4" '[ "$(grep -c "CPU part.*0xd46" "$OUT_DIR/cpuinfo")" -eq 4 ]'
check "A ARM64 shape: no x86 model-name tell" '! grep -qi "model name" "$OUT_DIR/cpuinfo"'
check "A ARM64 shape: no arm32 Hardware line" '! grep -q "^Hardware" "$OUT_DIR/cpuinfo"'
check "A both bind-mounts issued" '[ "$(wc -l < "$WA_MOUNT_LOG")" -eq 2 ] && grep -q "bind .*meminfo /proc/meminfo" "$WA_MOUNT_LOG" && grep -q "bind .*cpuinfo /proc/cpuinfo" "$WA_MOUNT_LOG"'
# meminfo second-order sanity (no nonsense: free/available never exceed total)
check "A MemFree < MemTotal" '[ "$(awk "/MemFree:/{print \$2}" "$OUT_DIR/meminfo")" -lt 11324620 ]'
check "A MemAvailable < MemTotal" '[ "$(awk "/MemAvailable:/{print \$2}" "$OUT_DIR/meminfo")" -lt 11324620 ]'
# VACUOUS GUARD: cpuinfo must never be an empty file with exit 0
check "A cpuinfo non-empty" '[ -s "$OUT_DIR/cpuinfo" ]'

# ---- case B: no carriers = legacy path, exit 0, nothing mounted -------------
: > "$WORK/props.B"
run_case B
check "B exit 0 (byte-inert legacy path)" '[ $RC -eq 0 ]'
check "B nothing mounted" '[ ! -s "$WA_MOUNT_LOG" ]'

# ---- case C/D: partial carriers = fail closed --------------------------------
printf 'ro.boot.oem_mem_total_kb 8000000\n' > "$WORK/props.C"
run_case C
check "C mem-only partial refused" '[ $RC -eq 1 ] && [ ! -s "$WA_MOUNT_LOG" ]'
printf 'ro.boot.oem_mem_total_kb 8000000\nro.boot.oem_cpu_cores 8\n' > "$WORK/props.D"
run_case D
check "D missing clusters refused" '[ $RC -eq 1 ] && [ ! -s "$WA_MOUNT_LOG" ]'

# ---- case E: malformed values --------------------------------------------------
printf 'ro.boot.oem_mem_total_kb 0x1000\nro.boot.oem_cpu_cores 8\nro.boot.oem_cpu_clusters 8:0x41:0xd05:0x0:0x0:66.66\n' > "$WORK/props.E"
run_case E
check "E non-numeric mem refused" '[ $RC -eq 1 ]'

# ---- case F: cluster sum != carrier cores (vacuous-assertion guard) ----------
printf 'ro.boot.oem_mem_total_kb 8000000\nro.boot.oem_cpu_cores 8\nro.boot.oem_cpu_clusters 9:0x41:0xd05:0x0:0x0:66.66\n' > "$WORK/props.F"
run_case F
check "F cluster/cores mismatch refused" '[ $RC -eq 1 ]'

# ---- case G: injection in cluster field rejected by charset guard ------------
printf 'ro.boot.oem_mem_total_kb 8000000\nro.boot.oem_cpu_cores 8\nro.boot.oem_cpu_clusters 8:0xd05;reboot\n' > "$WORK/props.G"
run_case G
check "G shell metachar in clusters refused" '[ $RC -eq 1 ] && [ ! -s "$WA_MOUNT_LOG" ]'

# ---- case H: mount failure propagates (exit != 0, init sees it) --------------
cat > "$WORK/stub/mount" <<'EOF'
#!/bin/sh
exit 13
EOF
chmod +x "$WORK/stub/mount"
run_case A
check "H mount failure surfaces (no silent success)" '[ $RC -ne 0 ]'
mkstub

echo
echo "test-proc-view: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
