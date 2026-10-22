#!/usr/bin/env bash
# =============================================================================
# BR-Acceptance C — Live Egress Kernel-Layer Verification — shared helpers
#
# SCOPE (boss-approved 2026-10-22 13:14, hard constraints):
#   - Touches ONLY: br-b6e-* containers, br-b6e-* networks, br-b6e-sidecar
#     image, logs/br-b6-egress/data-br-b6e-* dirs, this test's own traffic.
#   - NEVER: flushes firewall rules, changes global/default policies,
#     default routes, SSH, other docker networks, SGLang (127.0.0.1:30000),
#     water-army-* compose services, any port in 15000-15999.
#   - Host firewall rules: NONE are written by this harness (non-root host;
#     nft is EPERM for the service user). The C4 fail-closed strategy is the
#     Docker-native `internal` network (scoped to br-b6e-sec). A root
#     nft-variant is provided separately (nft-failclosed-template.nft) and
#     is NOT executed by any script here.
#
# Conventions:
#   - all docker via `sg docker -c` (service user is in the docker group)
#   - all container-local ports in 163xx (>=16360); NO host port listeners
#   - UTC + HKT dual timestamps on every recorded line
# =============================================================================

# --- paths (task-mandated evidence dir; NOT env-overridable — determinism) --
EGRESS_OUT="/home/kenneth/.openclaw/workspace/logs/br-b6-egress"
EGRESS_DATA="$EGRESS_OUT"

# --- pinned images (repo redline: dated tag + digest, never 'latest') -------
# Digests taken from repo config:
#   apps/api/src/services/redroid-service.js  GOST_IMAGE (Stage B)
#   scripts/br-b6lt/setup.sh                  REDROID_IMG  (BR-B6 G-series)
REDROID_IMG='water-army/redroid@sha256:591296d5656571f346994dc81608ca33744af4d0e9c9876241a8595e70143b55'
GOST_IMG='gogost/gost@sha256:f7a958c451928fbe1b99046d25bd0c9bf42019d4c60a82200f50dc8e617b7580'
ALPINE_IMG='alpine:3.20'
SIDECAR_IMG='br-b6e-sidecar:egress'

# --- network plan (scratch subnets, clear of all existing: docker0 172.17/16,
#     water-army-platform 172.38.100.0/24, water-army-devices 172.38.200.0/24,
#     LAN 192.168.31.0/24) ----------------------------------------------------
NET_OPEN='br-b6e-open'      SUB_OPEN='172.39.200.0/24'   CAN1_IP='172.39.200.10'
NET_SEC='br-b6e-sec'        SUB_SEC='172.39.201.0/24'    # C4: --internal
NET_CANARY='br-b6e-canary'  SUB_CANARY='172.39.202.0/24' CAN2_IP='172.39.202.10'
CANARY_PORT=16370

# --- names -------------------------------------------------------------------
DEV1='br-b6e-dev1'   GOST1='br-b6e-gost1'   CAN1='br-b6e-can1'
DEV2='br-b6e-dev2'   GOST2='br-b6e-gost2'   CAN2='br-b6e-can2'

# --- helpers -----------------------------------------------------------------
ts() { # dual timestamp: UTC + HKT
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') / $(TZ=Asia/Hong_Kong date '+%Y-%m-%dT%H:%M:%S%z')"
}
log() { echo "[$(ts)] $*" | tee -a "$EGRESS_OUT/egress-run.log"; }
dc() { sg docker -c "docker $*"; }

# netcheck = the EXACT in-device script the platform watchdog runs
# (apps/api/src/services/redroid-health.js buildT2sNetcheckScript).
# Parameterized here only for readability; commands are verbatim.
NETCHECK_SCRIPT='set -u
PSL=$(ps -ef | grep [t]un2socks | head -n1)
if [ -n "$PSL" ]; then PROCESS=alive; PID=$(printf "%s" "$PSL" | awk "{print \$2}"); else PROCESS=dead; PID=none; fi
L=$(ip link show tun0 2>/dev/null)
if [ -z "$L" ]; then IFACE=missing; elif printf "%s" "$L" | grep -q ",UP,"; then IFACE=up; else IFACE=down; fi
R=$(ip route show table 100 2>/dev/null)
if printf "%s" "$R" | grep -q "default via 10.8.0.2"; then ROUTE=present; else ROUTE=missing; fi
RU=$(ip rule show 2>/dev/null)
if printf "%s" "$RU" | grep -q "5000:"; then RULE=present; else RULE=missing; fi
G=$(ip route get 8.8.8.8 2>/dev/null)
if printf "%s" "$G" | grep -q "table 100"; then EFFECTIVE=tunnel; elif printf "%s" "$G" | grep -q "dev eth0"; then EFFECTIVE=direct; else EFFECTIVE=unknown; fi
echo "NETCHECK process=$PROCESS pid=$PID iface=$IFACE route=$ROUTE rule=$RULE effective=$EFFECTIVE"'

# Run NETCHECK inside the device's netns+pidns via a one-shot sidecar
# container (root-free equivalent of nsenter -t <pid> -n; the docker daemon
# does the netns/pidns join on our behalf).
netcheck() { # $1=device container name -> prints NETCHECK= line
  dc run --rm --net "container:$1" --pid "container:$1" --entrypoint sh \
    "$SIDECAR_IMG" -c "$NETCHECK_SCRIPT" 2>/dev/null | grep '^NETCHECK '
}

# Kernel-layer probe: one process bound to the device netns (NOT a platform-
# dispatched task). dst=canary IP; routing obeys the device's own tables:
# tunnel up  -> rule 5000 -> table 100 -> tun0 -> t2s -> gost -> canary
#              (canary logs src = gost container IP = via-proxy)
# tunnel dead-> table-100 default gone -> fall through main -> eth0
#              (canary logs src = device IP = DIRECT, the fail-open path)
probe() { # $1=device  $2=canary-ip  $3=tag  [$4=timeout_s]
  local dev="$1" canary="$2" tag="$3" to="${4:-6}"
  log "PROBE ${dev} -> http://${canary}/tag=${tag} (timeout ${to}s)"
  dc run --rm --net "container:$dev" --entrypoint busybox \
    "$SIDECAR_IMG" wget -q -T "$to" -O- "http://${canary}/tag=${tag}" 2>&1 \
    | sed "s/^/[probe:${tag}] /" | tee -a "$EGRESS_OUT/egress-run.log"
  local rc=$?
  log "PROBE ${tag} rc=$rc (0=HTTP 200 OK via canary; non-zero=connect/read fail — see canary log for what arrived)"
  return 0
}

# Raw TCP reachability check (no HTTP semantics) — used for the
# "proxy endpoint dead" evidence (RST vs timeout).
tcp_probe() { # $1=device  $2=host  $3=port  $4=tag
  local dev="$1" host="$2" port="$3" tag="$4"
  log "TCP-PROBE ${dev} -> ${host}:${port} tag=${tag}"
  dc run --rm --net "container:$dev" --entrypoint busybox \
    "$SIDECAR_IMG" nc -w 4 "$host" "$port" </dev/null 2>&1 \
    | sed "s/^/[tcpprobe:${tag}] /" | tee -a "$EGRESS_OUT/egress-run.log"
  return 0
}

# Marker line inside the canary log (exact phase boundaries, dual-stamped)
canary_mark() { # $1=canary container  $2=phase
  dc exec "$1" sh -c "echo \"MARK $(ts) $2\" >> /canary/conn.log" 2>/dev/null
}
