#!/usr/bin/env bash
# =============================================================================
# rdev-single P1 — single-box scratch boot (boss 17:13: scratch RAM gate = 8 GiB)
#
# Boot ONE named rdev-sN container from a given image + Cmd file.
#   - RAM redline: MemAvailable >= 8192 MiB before boot AND projected
#     post-boot (measured budget 2560 MiB/device) must stay >= 8192 MiB.
#   - 127.0.0.1-only ADB publish; network/subnet isolated per single box.
#   - pidfiles/labels for teardown; NEVER touches user stack / SGLang.
#
# Usage: boot.sh <name e.g. rdev-s1> <image> <port> <datadir> <cmdfile|"-" for none>
# =============================================================================
set -eu
NAME="$1"; IMAGE="$2"; PORT="$3"; DATADIR="$4"; CMDFILE="${5:--}"
EVID=/home/kenneth/.openclaw/workspace/water_army/logs/rdev-single
STATE=/tmp/rdev-single-state; mkdir -p "$STATE" "$EVID"
NET=br-rdev-single; SUBNET=172.38.223.0/24

ma() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
FLOOR=${RAM_GATE_FLOOR_MIB:-6144}   # boss 17:31: scratch redline lowered 8G -> 6G (product default 16G unchanged)
M=$(ma)
P=$((M - 2560))
if [ "$M" -lt "$FLOOR" ] || [ "$P" -lt "$FLOOR" ]; then
  echo "[rdev-single] RAM GATE DENY: MemAvailable=${M}MiB projected=${P}MiB (need >=${FLOOR}/${FLOOR})" | tee -a "$EVID/harness.log"
  exit 3
fi
echo "[rdev-single] $(date -u +%FT%TZ) RAM gate OK MemAvailable=${M}MiB projected_postboot=${P}MiB (gate=8192, budget=2560/device, boss 17:13 scratch override)" | tee -a "$EVID/harness.log"

# stale container with same name must be gone (idempotent re-run)
if [ -n "$(docker ps -aq -f name="^${NAME}$")" ]; then
  echo "[rdev-single] $NAME exists — remove first (teardown.sh)" | tee -a "$EVID/harness.log"; exit 4
fi

docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
mkdir -p "$DATADIR"; chmod 700 "$DATADIR"

OPTS=(run -d --name "$NAME" --network "$NET" --privileged \
  -v "$DATADIR:/data" \
  --label app.managed=true --label app.created-by=rdev-single \
  --label redroid.device.name="$NAME" \
  --memory 4g \
  -p "127.0.0.1:${PORT}:5555")
CMDARGS=()
if [ "$CMDFILE" != "-" ]; then
  # one arg per line
  while IFS= read -r a; do [ -n "$a" ] && CMDARGS+=("$a"); done < "$CMDFILE"
fi
CID=$(docker "${OPTS[@]}" "$IMAGE" "${CMDARGS[@]}")
echo "$CID" > "$STATE/$NAME.cid"
echo "[rdev-single] $NAME started cid=$CID adb=127.0.0.1:$PORT datadir=$DATADIR" | tee -a "$EVID/harness.log"
