#!/bin/bash
# WA-RESCAN S3: run the D1-口径 fx-cdp probe on fx-3 (default carrier, no flags).
set -u
ADB=/home/kenneth/.openclaw/workspace/tools/platform-tools/adb
S=127.0.0.1:15002
FX=/home/kenneth/.openclaw/workspace/water_army/docs/audits/rescan/evidence
$ADB -s $S shell "rm -f /data/local/tmp/webview-command-line /data/local/tmp/chrome-command-line"
$ADB -s $S shell am force-stop org.chromium.webview_shell
sleep 1
$ADB -s $S shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d 'data:text/html,<h1>boot</h1>'" >/dev/null
sleep 3
PID=$($ADB -s $S shell pidof org.chromium.webview_shell | tr -d '\r')
echo "webview pid=$PID"
$ADB -s $S forward --remove-all >/dev/null 2>&1
$ADB -s $S forward tcp:9323 "localabstract:webview_devtools_remote_$PID" >/dev/null
node /home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth-fix2/s1/fx-cdp.mjs 9323 "$FX/redroid-rdev-fx-3-cdp.json"
cat "$FX/redroid-rdev-fx-3-cdp.json"
