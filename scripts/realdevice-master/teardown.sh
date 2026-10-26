#!/usr/bin/env bash
# teardown.sh — zero-residue teardown of the rdev scratch fleet.
#
# Order: API-level (devices/templates/bindings) -> infra (pg/redis/egress/net)
# -> processes (api/web/sidecar/echo) -> adb -> disk (dataDir/apks) -> state
# (/tmp/rdev-state) -> VERIFY (recorded evidence). The user stack
# (water-army-* 5 containers + SGLang 30000) is asserted UNTOUCHED, never touched.
#
# Run ONLY at the very end (task item 6), after the CEO has reviewed the
# matrices — never automatically.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
EVID="${RD_EVID}/final"
mkdir -p "$EVID"
: > "$EVID/teardown-volumes.txt"
API=http://127.0.0.1:16490

# --- 0. admin cookie ---------------------------------------------------------
CK=$(mktemp)
curl -s -c "$CK" -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d '{"username":"rdev-admin","password":"rdev-e2e-admin-pw"}' > /dev/null || log FATAL "admin login failed"

# --- 1. devices (removeData:true = per-device data dir goes too) -------------
dev_json=$(curl -s -b "$CK" "$API/api/devices/redroid")
mapfile -t DEVPAT < <(echo "$dev_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{JSON.parse(s).devices.forEach(d=>console.log(d.id+' '+d.name))}catch{}})")
for pat in "${DEVPAT[@]:-}"; do
  [ -z "$pat" ] && continue
  id=${pat%% *}; name=${pat#* }
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" -X DELETE "$API/api/devices/redroid/$id" \
    -H 'content-type: application/json' -d "{\"confirm\":\"$name\",\"removeData\":true}" )
  log teardown "device $name deleted ($code)"
done

# --- 2. templates -------------------------------------------------------------
for t in rdev-w3 rdev-base; do
  tid=$(curl -s -b "$CK" "$API/api/redroid/templates" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const t=(JSON.parse(s).templates||JSON.parse(s).items||[]).find(x=>x.name==='$t');console.log(t?t.id:'')}catch{console.log('')}})")
  [ -z "$tid" ] && continue
  curl -s -b "$CK" -X DELETE "$API/api/redroid/templates/$tid" > /dev/null
  log teardown "template $t deleted"
done

# --- 3. egress bindings (c1/c2/c3 + any) --------------------------------------
psql_out=$(printf "SELECT identity_id FROM identity_egress_bindings;\n" | docker exec -i rdev-pg psql -U postgres -d water_army_rdev -tA -v ON_ERROR_STOP=1 2>/dev/null || true)
for i in $psql_out; do
  curl -s -b "$CK" -X DELETE "$API/api/identities/$i/egress" > /dev/null
  log teardown "binding $i deleted"
done

# --- 4. scratch DB users (via seed script teardown) ---------------------------
node "$SCRIPT_DIR/seed-users.mjs" --teardown >> "$EVID/teardown.log" 2>&1 || true

# --- 5. infra containers + network ---------------------------------------------
# (anonymous volumes of pg/redis are captured and wiped too — `docker rm -f`
# leaves them behind with the scratch DB data = residue, 2026-10-27 leg-2 audit)
for c in rdev-egress-a rdev-egress-b rdev-egress-c rdev-egress-d rdev-dnslog "$RD_PGC" "$RD_RDC"; do
  vols=$(docker inspect "$c" --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' 2>/dev/null || true)
  docker rm -f "$c" >/dev/null 2>&1 && log teardown "container $c removed" || log teardown "container $c already gone"
  for v in $vols; do docker volume rm "$v" >/dev/null 2>&1 && { log teardown "anonymous volume $v removed"; echo "$v" >> "$EVID/teardown-volumes.txt"; }; done
done
docker network rm "$RD_NET" >/dev/null 2>&1 && log teardown "network $RD_NET removed" || log teardown "network $RD_NET already gone"

# --- 6. scratch processes (cgroup-guarded stop) --------------------------------
for pf in api.pid web.pid sidecar.pid echo.pid; do
  stop_by_pidfile "$RD_STATE/$pf" && log teardown "$pf stopped"
done

# --- 6b. sidecar belt-and-suspenders -------------------------------------------
# The sidecar is a child of the API process (no pidfile): API graceful SIGTERM
# kills it via the stream-sidecar plugin close (3s grace). But if stop_by_pidfile
# had to SIGKILL the API (>6s), the sidecar orphans with 16493 still open.
SPID=$(ss -tlnp 2>/dev/null | grep ':16493 ' | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$SPID" ]; then
  cg=$(cat "/proc/$SPID/cgroup" 2>/dev/null | head -1 || true)
  case "$cg" in *docker*) log FATAL "refusing to kill sidecar $SPID — cgroup docker-scoped: $cg";;
  *) kill "$SPID" 2>/dev/null || true
     for i in $(seq 1 30); do kill -0 "$SPID" 2>/dev/null || break; sleep 0.2; done
     kill -9 "$SPID" 2>/dev/null || true
     log teardown "sidecar $SPID stopped (survived api stop)";;
  esac
else
  log teardown "sidecar already gone (died with api)"
fi

# --- 7. adb sessions -------------------------------------------------------------
ndis=$("$RD_ADB" disconnect 2>/dev/null | grep -c 165 || true)
log teardown "adb 165xx disconnects: ${ndis:-0}"
"$RD_ADB" devices 2>/dev/null | awk 'NR>1 && $1 ~ /127.0.0.1:165/ {print $1}' | while read -r s; do "$RD_ADB" disconnect "$s" >/dev/null 2>&1; done

# --- 8. disk: data root + apk fixtures -------------------------------------------
# (relay leg-2, live find 2026-10-27 teardown run1): device dataDirs contain
# ROOT-OWNED subdirs (docker creates them inside the bind source) — plain
# `find -delete` gets "Permission denied" (silenced by 2>/dev/null before), and
# wiping within seconds of `docker rm` races in-flight unmounts (EBUSY). Both
# observed live: run1 left the full data root behind. Fix: bounded retries,
# then a disposable privileged alpine container (docker root, no sudo needed);
# rmdir AFTER the container exits (its own bind mount holds the path while
# running — also observed live). Residue is FAILED loudly, not logged past.
wipe_data_root() {
  [ -d "$RD_DATA_ROOT" ] || return 0
  local attempt img
  for attempt in 1 2 3; do
    find "$RD_DATA_ROOT" -mindepth 1 -delete 2>/dev/null
    rmdir "$RD_DATA_ROOT" 2>/dev/null && { log teardown "data root cleared (attempt $attempt)"; return 0; }
    sleep 3
  done
  img=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^alpine:' | head -1)
  if [ -n "$img" ]; then
    docker run --rm --privileged -v "$RD_DATA_ROOT":/t "$img" sh -c 'find /t -mindepth 1 -delete' >/dev/null 2>&1
    rmdir "$RD_DATA_ROOT" 2>/dev/null && { log teardown "data root cleared (root-owned residue via disposable $img)"; return 0; }
  fi
  log FATAL "data root $RD_DATA_ROOT NOT fully wiped — residue: $(ls "$RD_DATA_ROOT" 2>/dev/null | wc -l) entries; manual sudo required"
  return 1
}
wipe_data_root
[ -d /var/lib/water-army/apk-rdev ] && rm -rf /var/lib/water-army/apk-rdev && log teardown "apk-rdev removed"

# --- 9. /tmp state (canary fixture + pidfiles + cookies) -------------------------
rm -rf "$RD_STATE" && log teardown "RD_STATE ($RD_STATE) removed"
rm -f "$CK"

# --- 10. VERIFY (evidence) ---------------------------------------------------------
{
  echo "=== zero-residue verification $(date -u +%FT%TZ) ==="
  echo "-- rdev containers (expect 0):"
  docker ps -a --filter name=rdev --format '{{.Names}} {{.Status}}'
  echo "-- rdev containers count: $(docker ps -a --filter name=rdev -q | wc -l)"
  echo "-- network br-rdev-ladder (expect absent):"
  docker network ls --filter name=br-rdev-ladder --format '{{.Name}}'
  echo "-- ports 16490-16495 + 16460-16469 sidecar fwd (expect no LISTEN):"
  for p in 16490 16491 16492 16493 16494 16495 16460 16461 16462 16463 16464 16465 16466 16467 16468 16469; do ss -tln 2>/dev/null | awk -v p=":$p" '$4 ~ p {print "LISTEN " p}'; done
  echo "-- data root (expect absent):"
  ls -ld "$RD_DATA_ROOT" 2>&1 | head -1
  echo "-- rdev scratch anonymous volumes (expect all removed):"
  if [ -s "$EVID/teardown-volumes.txt" ]; then
    while read -r v; do [ -z "$v" ] && continue; docker volume inspect "$v" >/dev/null 2>&1 && echo "STILL EXISTS $v" || echo "removed $v"; done < "$EVID/teardown-volumes.txt"
  else
    echo "(none captured)"
  fi
  echo "-- apk-rdev (expect absent):"
  ls -ld /var/lib/water-army/apk-rdev 2>&1 | head -1
  echo "-- RD_STATE (expect absent):"
  ls -ld "$RD_STATE" 2>&1 | head -1
  echo "-- adb 165xx (expect 0):"
  "$RD_ADB" devices 2>/dev/null | awk 'NR>1 && $1 ~ /127.0.0.1:165/ {c++} END {print c+0}'
  echo "-- USER STACK (expect 5/5 running — untouched):"
  docker ps --filter name=water-army --format '{{.Names}} {{.Status}}'
  echo "user-stack count: $(docker ps --filter name=water-army -q | wc -l)/5"
  echo "-- SGLang 30000 (expect alive — untouched):"
  curl -s --max-time 5 http://127.0.0.1:30000/health && echo || echo "sglang: check"
  echo "-- RAM:"
  free -g | awk '/^Mem:/{print "MemAvailable="$7"G"}'
} > "$EVID/teardown-verify.txt" 2>&1
log teardown "verification -> $EVID/teardown-verify.txt"
cat "$EVID/teardown-verify.txt"
