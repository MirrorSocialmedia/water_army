#!/bin/bash
# D2 network phase driver (fail-closed test, container probes, b1 create attempt)
set -u
ADB=/home/kenneth/.local/share/platform-tools/adb
D2=/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
D1=/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1
cd "$D2"
TOKEN=$(cat /tmp/adv-session-token)

echo "=== settings/proxy/route per device $(date -Is) ===" > proxy-routes.txt
declare -A PORTS=( [a1]=15000 [a2]=15001 [a3]=15002 [a4]=15003 )
for dev in a1 a2 a3 a4; do
  A="$ADB -s 127.0.0.1:${PORTS[$dev]}"
  echo "-- $dev http_proxy: $($A shell settings get global http_proxy | tr -d '\r')" >> proxy-routes.txt
  echo "-- $dev ip route:" >> proxy-routes.txt
  $A shell ip route | tr -d '\r' | sed 's/^/   /' >> proxy-routes.txt
  echo "-- $dev netns ifaces:" >> proxy-routes.txt
  $A shell ip addr | grep -E "^[0-9]+:" | tr -d '\r' | sed 's/^/   /' >> proxy-routes.txt
done
cat proxy-routes.txt

echo "=== fail-closed test on a4 (sidecar stop/start) $(date -Is) ===" | tee failclosed.txt
docker stop redroid-matrix-b-gost-redroid-rdev-adv-a4 >> failclosed.txt 2>&1
sleep 2
$ADB -s 127.0.0.1:15003 shell ping -c 2 -W 5 8.8.8.8 2>&1 | tail -3 | tr -d '\r' | sed 's/^/[sidecar-down ping] /' | tee -a failclosed.txt
# webview probe with sidecar down (expect fetch fail/timeout)
node cdp-failclosed.mjs 9324 a4 2>&1 | tee -a failclosed.txt
docker start redroid-matrix-b-gost-redroid-rdev-adv-a4 >> failclosed.txt 2>&1
sleep 3
echo "=== a4 sidecar restored; probe again ===" >> failclosed.txt
node cdp-failclosed.mjs 9324 a4 2>&1 | tail -1 | tee -a failclosed.txt

echo "=== container net probes (JA3 capture window) $(date -Is) ==="
for dev in a1 a2 a3 a4; do
  A="$ADB -s 127.0.0.1:${PORTS[$dev]}"
  hp=$((9320 + PORTS[$dev] - 15000 + 1))
  $A shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d 'https://ipinfo.io/'" >/dev/null 2>&1
  sleep 6
  P=$($A shell pidof org.chromium.webview_shell | tr -d '\r')
  $A forward tcp:$hp localabstract:webview_devtools_remote_$P >/dev/null
  node cdp-net.mjs $hp $dev 2>&1 | tail -1
  echo "-- $dev: $(grep -o '"egress": *"[^"]*"' net-$dev.json)"
done
echo "probes done $(date -Is)"

echo "=== b1 create attempt (RAM gate live) $(date -Is) ===" | tee b1-create.txt
free -m | awk 'NR==2{printf "MemAvailableMiB=%s\n", $7}' | tee -a b1-create.txt
docker exec water-army-api-1 node -e "fetch('http://127.0.0.1:3000/api/devices/redroid',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'session=$TOKEN'},body:JSON.stringify({name:'redroid-rdev-adv-b1',templateName:'adv-stealth',idempotencyKey:'adv-b1-gen2-' + Date.now(),identityId:'4a469ae2-5e8e-4e04-9cff-7229d8922dd9',overrides:{width:1080,height:2340,dpi:395,fps:90},proxyUrl:'socks5://172.38.223.1:18444'})}).then(async r=>{const b=await r.json();console.log(JSON.stringify({status:r.status,body:b}))})" >> b1-create.txt 2>&1
tail -c 600 b1-create.txt
