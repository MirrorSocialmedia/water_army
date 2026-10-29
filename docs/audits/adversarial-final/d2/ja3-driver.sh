#!/bin/bash
# JA3/JA4 capture window: tcpdump eno1 port443 while 4 devices re-fetch TLS + node control probe
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
ADB=/home/kenneth/.local/share/platform-tools/adb
IF=eno1
docker rm -f ja3cap >/dev/null 2>&1
docker run -d --name ja3cap --net=host --privileged -v "$PWD":/cap alpine:3.20 sh -c 'apk add --no-cache tcpdump >/dev/null 2>&1; tcpdump -i '"$IF"' -nn -c 6000 -w /cap/ja3-capture.pcap "tcp port 443 and greater 120" 2>/cap/ja3-tcpdump.log' >/dev/null
sleep 18
echo "capture up $(date -Is)"
for spec in "a1 15000" "a2 15001" "a3 15002" "a4 15003"; do
  set -- $spec
  A="$ADB -s 127.0.0.1:$2"
  $A shell "am force-stop org.chromium.webview_shell" >/dev/null 2>&1
  sleep 2
  # two distinct TLS endpoints per device to enrich hello sampling
  $A shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d https://ipinfo.io/json" >/dev/null 2>&1
  sleep 6
  $A shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d https://httpbin.org/status/418" >/dev/null 2>&1
  sleep 8
  echo "$1 fetched $(date -Is)"
done
# node control-plane fingerprint sample (host, direct)
node -e "fetch('https://ipinfo.io/ip').then(r=>r.text()).then(t=>console.log('NODE_IP',t.trim()))" > node-control.txt 2>&1
node -e "fetch('https://httpbin.org/status/418').then(r=>console.log('NODE_HTTPBIN',r.status))" >> node-control.txt 2>&1
sleep 12
docker stop ja3cap >/dev/null 2>&1
ls -la ja3-capture.pcap; tail -2 ja3-tcpdump.log 2>/dev/null
docker logs ja3cap 2>&1 | tail -2
