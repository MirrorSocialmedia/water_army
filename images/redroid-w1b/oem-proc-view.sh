#!/system/bin/sh
# water_army L2 wave-2 (ADR-033) — per-identity /proc view renderer + binder.
#
# Runs from /vendor/etc/init/oem-proc-view.rc at init `post-fs-data` (after
# /proc is mounted, strictly before zygote — no Android process ever maps the
# host meminfo first). Renders the per-identity fake /proc/meminfo +
# /proc/cpuinfo from the androidboot.oem_mem_* Cmd carriers (same carrier
# pattern as the identity ro.* props, ADR-028/031) and bind-mounts them over
# the host-penetrating originals (exposure-surfaces D10/D11, appendix A:
# the container saw host RAM/x86 CPU names straight through the shared kernel).
#
# Contract (asserted by test/test-proc-view.sh, host-stubbed, no boot):
#   - NO mem carrier   -> exit 0, nothing mounted (legacy identity / carrier
#                         switch off = today's image behaviour, byte-inert)
#   - PARTIAL carriers -> exit 1 (all-or-none; init logs the exit code)
#   - full carriers    -> /proc/meminfo MemTotal == ro.boot.oem_mem_total_kb
#                         and /proc/cpuinfo renders exactly oem_cpu_cores
#                         ARM64-style cores from the oem_cpu_clusters encoding
#   - malformed values -> exit 1 (carriers are untrusted cmdline input)
#
# Notes:
#   - meminfo/cpuinfo are NOT pid/cgroup-namespaced kernel files — the
#     bind-mount is the whole point. Static file = a snapshot (MemFree never
#     drifts); documented limitation in ADR-033, better than leaking host RAM.
#   - toybox-sh discipline: /system/bin/sh is toybox on the base image —
#     POSIX arithmetic only, no GNU-isms. This file must also run under the
#     host sh (test harness) with getprop/mount stubbed via PATH.

log_note() {
  # best-effort: toybox `log` exists on the base image; never fatal
  command -v log >/dev/null 2>&1 && log -t oem-proc-view "$1" 2>/dev/null
}

MEM_KB=$(getprop ro.boot.oem_mem_total_kb)
CORES=$(getprop ro.boot.oem_cpu_cores)
CLUSTERS=$(getprop ro.boot.oem_cpu_clusters)

# --- absent-everything = legacy path (byte-inert image default) -------------
if [ -z "$MEM_KB" ]; then
  if [ -n "$CORES" ] || [ -n "$CLUSTERS" ]; then
    log_note "partial carriers (mem absent, cores/clusters present) - REFUSING"
    exit 1
  fi
  exit 0
fi
if [ -z "$CORES" ] || [ -z "$CLUSTERS" ]; then
  log_note "partial carriers (mem present, cores/clusters absent) - REFUSING"
  exit 1
fi

# --- input validation (cmdline is untrusted) --------------------------------
case "$MEM_KB" in '' | *[!0-9]*) log_note "bad mem_total_kb"; exit 1 ;; esac
case "$CORES" in '' | *[!0-9]*) log_note "bad cpu_cores"; exit 1 ;; esac
case "$CLUSTERS" in '' | *[!0-9a-fx:,.]*) log_note "bad cpu_clusters charset"; exit 1 ;; esac

DIR="${OEM_PROC_TMPDIR:-/dev/oem-proc}"
mkdir -p "$DIR" 2>/dev/null || { log_note "cannot create $DIR"; exit 1; }

# --- render meminfo ----------------------------------------------------------
# Derived second-order values use fixed integer ratios; per-identity variation
# comes from MemTotal itself (the platform jitters the carrier per identity).
# Contract-critical line: MemTotal == carrier (exact).
T=$MEM_KB
{
  printf '%-13s%8s kB\n' 'MemTotal:' "$T"
  printf '%-13s%8s kB\n' 'MemFree:' $((T * 27 / 100 + T % 101))
  printf '%-13s%8s kB\n' 'MemAvailable:' $((T * 52 / 100 + T % 97))
  printf '%-13s%8s kB\n' 'Buffers:' $((T * 8 / 1000 + T % 13))
  printf '%-13s%8s kB\n' 'Cached:' $((T * 33 / 100 + T % 89))
  printf '%-13s%8s kB\n' 'SwapCached:' $((T % 313))
  printf '%-13s%8s kB\n' 'Active:' $((T * 31 / 100))
  printf '%-13s%8s kB\n' 'Inactive:' $((T * 19 / 100))
  printf '%-13s%8s kB\n' 'Dirty:' $((T % 20481))
  printf '%-13s%8s kB\n' 'Writeback:' 0
  printf '%-13s%8s kB\n' 'AnonPages:' $((T * 14 / 100))
  printf '%-13s%8s kB\n' 'Mapped:' $((T * 9 / 100))
  printf '%-13s%8s kB\n' 'Shmem:' $((T * 2 / 100))
  printf '%-13s%8s kB\n' 'Slab:' $((T * 3 / 100))
  printf '%-13s%8s kB\n' 'SReclaimable:' $((T * 11 / 1000))
  printf '%-13s%8s kB\n' 'SUnreclaim:' $((T * 19 / 1000))
  printf '%-13s%8s kB\n' 'KernelStack:' $((8192 + T % 2049))
  printf '%-13s%8s kB\n' 'PageTables:' $((T * 7 / 1000))
  printf '%-13s%8s kB\n' 'CommitLimit:' $((T * 3 / 4))
  printf '%-13s%8s kB\n' 'Committed_AS:' $((T * 42 / 100))
  printf '%-13s%8s kB\n' 'VmallocUsed:' $((163840 + T % 8193))
  printf '%-13s%8s kB\n' 'Percpu:' 4096
  printf '%s\n' 'Hugepagesize:       2048 kB'
} > "$DIR/meminfo" || { log_note "meminfo render failed"; exit 1; }

# --- render cpuinfo (ARM64 kernel shape; cores = cluster expansion) ---------
# Encoding: count:impl:part:variant:revision:bogo per cluster, comma-joined
# (device-spec encodeClusters()). NO 'model name'/'Hardware' lines — those are
# x86/arm32 artifacts; an ARM64 cpuinfo carrying them is itself a tell.
FEATURES='fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 asimdfhm dit uscat ilrcpc flagm ssbs paca pacp'
: > "$DIR/cpuinfo" || { log_note "cpuinfo open failed"; exit 1; }
i=0
SAVEIFS=$IFS
IFS=,
for CL in $CLUSTERS; do
  IFS=:
  set -- $CL
  IFS=$SAVEIFS
  CNT=$1; IMPL=$2; PART=$3; VAR=$4; REV=$5; BOGO=$6
  case "$CNT" in '' | *[!0-9]*) IFS=$SAVEIFS; log_note "bad cluster count"; exit 1 ;; esac
  case "$IMPL$PART$VAR$REV" in *[!0-9a-fx]*) IFS=$SAVEIFS; log_note "bad cluster hex field"; exit 1 ;; esac
  case "$BOGO" in *[!0-9.]* | '') IFS=$SAVEIFS; log_note "bad bogo"; exit 1 ;; esac
  n=0
  while [ "$n" -lt "$CNT" ]; do
    printf 'processor\t: %s\nBogoMIPS\t: %s\nFeatures\t: %s\nCPU implementer\t: %s\nCPU architecture: 8\nCPU variant\t: %s\nCPU part\t: %s\nCPU revision\t: %s\n\n' \
      "$i" "$BOGO" "$FEATURES" "$IMPL" "$VAR" "$PART" "$REV" >> "$DIR/cpuinfo" || exit 1
    i=$((i + 1)); n=$((n + 1))
  done
done
IFS=$SAVEIFS
# VACUOUS GUARD: rendered core count must equal the carrier exactly —
# a truncated/oversubscribed cluster string is a broken story, not a pass.
[ "$i" -eq "$CORES" ] || { log_note "cluster expansion rendered $i cores != carrier $CORES - REFUSING"; exit 1; }

# --- bind-mount over the host-penetrating originals --------------------------
mount -o bind "$DIR/meminfo" /proc/meminfo || { log_note "bind meminfo FAILED"; exit 1; }
mount -o bind "$DIR/cpuinfo" /proc/cpuinfo || { log_note "bind cpuinfo FAILED"; exit 1; }
log_note "proc view active: MemTotal=${T}kB cores=${CORES}"
exit 0
