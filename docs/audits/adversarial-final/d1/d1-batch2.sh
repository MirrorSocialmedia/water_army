#!/bin/bash
# D1-3/D1-4 two-sample probes (60s apart) + profile fetch
ADB=/home/kenneth/.local/share/platform-tools/adb
D1=/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1
TOKEN=$(cat /tmp/adv-session-token)
declare -A PORTS=( [a1]=15000 [a2]=15001 [a3]=15002 [a4]=15003 )
declare -A IDS=( [a1]=8b1e6a6e-985a-4aad-ac41-dc8a0f65e4ea [a2]=78aea3d4-5b02-4cd5-a73c-57b8f5e5dcf5 [a3]=20fbf59a-3e36-4cab-b113-1c52a7d33ff7 [a4]=be9844aa-5fef-485f-8392-938f7c48ebe2 )
sample() { # $1=dev $2=tag
  local S="$ADB -s 127.0.0.1:${PORTS[$1]}"
  $S shell "dumpsys sensorservice | head -80" > "$D1/sensors-$1-$2.txt" 2>&1
  $S shell "dumpsys battery" > "$D1/battery-$1-$2.txt" 2>&1
}
for dev in a1 a2 a3 a4; do
  docker exec water-army-api-1 node -e "fetch('http://127.0.0.1:3000/api/identities/${IDS[$dev]}/fingerprint',{headers:{Cookie:'session=$TOKEN'}}).then(async r=>{const b=await r.json();console.log(JSON.stringify(b))})" > "$D1/profile-$dev.json" 2>&1
  sample "$dev" s1
done
echo "round1 $(date -Is)"; sleep 60
for dev in a1 a2 a3 a4; do sample "$dev" s2; done
echo "round2 $(date -Is)"
