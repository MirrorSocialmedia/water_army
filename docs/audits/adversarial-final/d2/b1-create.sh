#!/bin/bash
# b1 create attempt via product API (RAM gate live). Idempotent key unique per run.
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
TOKEN=$(cat /tmp/adv-session-token)
echo "=== b1 create attempt (RAM gate live) $(date -Is) ===" > b1-create.txt
free -m | awk 'NR==2{printf "MemAvailableMiB=%s\n", $7}' >> b1-create.txt
docker exec water-army-api-1 node -e "fetch('http://127.0.0.1:3000/api/devices/redroid',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'session=$TOKEN'},body:JSON.stringify({name:'redroid-rdev-adv-b1',templateName:'adv-stealth',idempotencyKey:'adv-b1-gen2-1836',identityId:'4a469ae2-5e8e-4e04-9cff-7229d8922dd9',overrides:{width:1080,height:2340,dpi:395,fps:90},proxyUrl:'socks5://172.38.223.1:18444'})}).then(async r=>{const b=await r.json();console.log(JSON.stringify({status:r.status,body:b}))}).catch(e=>console.log('FETCHERR',e.message))" >> b1-create.txt 2>&1
tail -c 700 b1-create.txt
