#!/bin/bash
TOKEN=$(cat /tmp/adv-session-token)
Q() { docker exec water-army-api-1 node -e "fetch('http://127.0.0.1:3000$1',{headers:{Cookie:'session=$TOKEN'}}).then(async r=>{const b=await r.text();console.log(b.slice(0,${2:-1200}))}).catch(e=>console.log('ERR',e.message))"; }
echo "== identities =="; Q /api/identities
echo "== warm states =="
for id in $(Q /api/identities 8000 | python3 -c "import json,sys,re
d=sys.stdin.read()
print(' '.join(re.findall(r'\"id\":\\s*\"([0-9a-f-]{36})\"', d)))" 2>/dev/null); do
  Q /api/identities/$id/warm 400
done
