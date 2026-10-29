#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
TOKEN=$(cat /tmp/adv-session-token)
F() { docker exec water-army-api-1 node -e "fetch('http://127.0.0.1:3000$1',{headers:{Cookie:'session=$TOKEN'}}).then(async r=>{console.log(JSON.stringify({s:r.status,b:await r.text()}).slice(0,${2:-1500}))}).catch(e=>console.log('ERR',e.message))"; }
F /api/identities 9000 > identities.json
F /api/devices/redroid 6000 > devices.json
F /api/batches 4000 > batches.json
F /api/egress-groups 1500 > egress-groups.json
echo "== worker env (WA_*) =="; docker exec water-army-worker-1 env | grep -E "^WA_" | sort > worker-env.txt; cat worker-env.txt
python3 - <<'EOF'
import json
for f in ['identities.json']:
    d=json.load(open(f)); b=json.loads(d['b']); items=b.get('items',[])
    adv=[i for i in items if 'adv' in (i.get('displayName') or '').lower() or (i.get('createdAt') or '').startswith('2026-10-29')]
    print('ADV/10-29 identities:', [(i['id'][:8], i['displayName'], i['warmState'], i['status'], i['createdAt'][11:19]) for i in adv])
    print('total identities:', len(items))
EOF
