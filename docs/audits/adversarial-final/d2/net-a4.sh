#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
ADB=/home/kenneth/.local/share/platform-tools/adb
A="$ADB -s 127.0.0.1:15003"
$A shell "am force-stop org.chromium.webview_shell" >/dev/null 2>&1
sleep 2
$A shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d https://ipinfo.io/" >/dev/null 2>&1
sleep 8
P=$($A shell pidof org.chromium.webview_shell | tr -d '\r')
$A forward tcp:9324 localabstract:webview_devtools_remote_$P >/dev/null
timeout 110 node cdp-net.mjs 9324 a4 2>&1 | tail -2
echo "a4 exit=$? $(date -Is)"
