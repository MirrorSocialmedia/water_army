#!/bin/bash
# Browser probe driver: launches webview_shell per device, CDP probe, injects real touch taps mid-probe.
ADB=/home/kenneth/.local/share/platform-tools/adb
D1=/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1
cd "$D1"
declare -A PORTS=( [a1]=15000 [a2]=15001 [a3]=15002 [a4]=15003 )
BASE=9320
for dev in a1 a2 a3 a4; do
  A="$ADB -s 127.0.0.1:${PORTS[$dev]}"
  hp=$((BASE + PORTS[$dev] - 15000 + 1))
  $A shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d 'data:text/html,<h1>boot</h1>'" >/dev/null 2>&1
  sleep 3
  P=$($A shell pidof org.chromium.webview_shell | tr -d '\r')
  if [ -z "$P" ]; then echo "$dev: webview pid MISSING"; continue; fi
  $A forward tcp:$hp localabstract:webview_devtools_remote_$P >/dev/null
  node cdp-probe.mjs $hp $dev > probe-$dev.log 2>&1 &
  NODEPID=$!
  sleep 4
  $A shell input tap 540 1200; $A shell input tap 300 800
  wait $NODEPID
  $A exec-out screencap -p > "shot-$dev.png" 2>/dev/null
  echo "$dev done $(date -Is) : $(cat probe-$dev.log)"
done
