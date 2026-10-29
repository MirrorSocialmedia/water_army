#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
ADB=/home/kenneth/.local/share/platform-tools/adb
for spec in "a1 15000 9321" "a2 15001 9322" "a3 15002 9323" "a4 15003 9324"; do
  set -- $spec
  A="$ADB -s 127.0.0.1:$2"
  P=$($A shell pidof org.chromium.webview_shell | tr -d '\r')
  $A forward tcp:$3 localabstract:webview_devtools_remote_$P >/dev/null
  timeout 40 node cdp-dns.mjs $3 $1 2>&1 | tail -1
done
