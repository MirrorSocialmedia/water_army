#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
TOKEN=$(cat /tmp/adv-session-token)
G() { docker exec water-army-api-1 node -e "fetch('http://127.0.0.1:3000$1',{headers:{Cookie:'session=$TOKEN'}}).then(r=>r.text()).then(b=>console.log(b)).catch(e=>console.log('ERR',e.message))" > "$2"; echo "$2 $(wc -c < "$2")B"; }
G "/api/identities" identities.json
G "/api/devices/redroid" devices.json
G "/api/tasks/runs?pageSize=100" runs.json
G "/api/warm/threshold" warm-threshold.json
