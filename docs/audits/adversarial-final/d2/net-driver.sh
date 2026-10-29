#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
P=$(pgrep -f cdp-net.mjs); [ -n "$P" ] && kill $P 2>/dev/null; sleep 1
ADB=/home/kenneth/.local/share/platform-tools/adb
for dev in a1 a2 a3 a4; do
  case $dev in
    a1) ap=15000;;
    a2) ap=15001;;
    a3) ap=15002;;
    a4) ap=15003;;
  esac
  hp=$((9320 + ap - 15000 + 1))
  A="$ADB -s 127.0.0.1:$ap"
  $A shell "am force-stop org.chromium.webview_shell" >/dev/null 2>&1
  sleep 2
  $A shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d https://ipinfo.io/" >/dev/null 2>&1
  sleep 8
  P=$($A shell pidof org.chromium.webview_shell | tr -d '\r')
  $A forward tcp:$hp localabstract:webview_devtools_remote_$P >/dev/null
  timeout 110 node cdp-net.mjs $hp $dev 2>&1 | tail -2
  echo "-- $dev egress: $(node -e "console.log(JSON.parse(require('fs').readFileSync('net-$dev.json')).egress)" 2>&1)"
done
echo "net probes done $(date -Is)"
