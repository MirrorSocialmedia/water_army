#!/bin/bash
# WA-FIX2B R2 bisect round: $1=mask.json $2=tag
set -u
A=/home/kenneth/.openclaw/workspace/tools/platform-tools/adb; S=127.0.0.1:15004
cd /tmp/wa-bisect
node mutate.mjs "/tmp/wa-bisect/lib-$2.so" "mask-$2.json" || exit 2
docker cp "/tmp/wa-bisect/lib-$2.so" redroid-rdev-fx-2:/vendor/lib64/dri/libgallium_dri.so || exit 2
docker exec redroid-rdev-fx-2 sh -c 'stop; start' >/dev/null 2>&1
sleep 50; $A connect $S >/dev/null
for i in $(seq 1 24); do B=$($A -s $S shell getprop sys.boot_completed 2>/dev/null | tr -d '\r'); [ "$B" = "1" ] && break; sleep 5; done
[ "$B" = "1" ] || { echo "RESULT $2 BOOT_TIMEOUT"; exit 3; }
$A -s $S shell "am force-stop org.chromium.webview_shell; am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d 'data:text/html,<h1>boot</h1>'" >/dev/null
sleep 5
PID=$($A -s $S shell pidof org.chromium.webview_shell | tr -d '\r')
$A -s $S forward --remove-all; $A -s $S forward tcp:9401 localabstract:webview_devtools_remote_$PID >/dev/null
sleep 1
node /home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth-fix2/s1/fx-cdp.mjs 9401 "/tmp/wa-bisect/cdp-$2.json" >/dev/null 2>&1
python3 - "$2" <<'PY'
import json,sys
try:
  d=json.load(open(f'/tmp/wa-bisect/cdp-{sys.argv[1]}.json')); g=d.get('gl',{})
  print(f"RESULT {sys.argv[1]} {'ALIVE' if not g.get('err') else 'DEAD'} vendor={g.get('unmaskedVendor')} renderer={g.get('unmaskedRenderer')}")
except Exception as e:
  print(f"RESULT {sys.argv[1]} PROBE_FAIL {e}")
PY
