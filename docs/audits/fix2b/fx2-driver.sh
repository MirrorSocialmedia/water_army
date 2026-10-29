#!/bin/bash
# WA-FIX2B — fx device probe driver (stealth3 verdicts; adapted from s1-driver).
# Usage: NAME=redroid-rdev-fx-2 bash docs/audits/fix2b/fx2-driver.sh
set -u
ADB=/home/kenneth/.openclaw/workspace/tools/platform-tools/adb
C="${NAME:?set NAME=redroid-rdev-fx-N}"
FX=/home/kenneth/.openclaw/workspace/water_army/docs/audits/fix2b
P=water-army-postgres-1
U=$(docker exec $P printenv POSTGRES_USER); D=$(docker exec $P printenv POSTGRES_DB)
PORT=$(docker exec -i $P psql -U $U -d $D -tAc "SELECT adb_port FROM devices WHERE name='$C';")
S="127.0.0.1:${PORT:?adb_port not found for $C}"
HP="${HPORT:-9401}"
BAT_STATE='dumpsys battery | sed -n "s/\r//g"'
echo "== [$C] adb serial $S =="
$ADB connect $S >/dev/null 2>&1

echo "== props / native GLES (dumpsys glGetString face) ==" | tee "$FX/$C-props-gl.txt"
docker exec $C sh -c 'getprop ro.hardware.vulkan; getprop ro.hardware.egl; getprop ro.board.platform; dumpsys SurfaceFlinger 2>/dev/null | grep -i -m1 "GLES:"' >> "$FX/$C-props-gl.txt" 2>&1

echo "== wlan MAC (s5 retest) ==" | tee "$FX/$C-mac.txt"
docker exec $C sh -c 'ip link show wlan0 2>/dev/null | grep -i ether; settings get global wifi_macaddress 2>/dev/null' >> "$FX/$C-mac.txt" 2>&1

echo "== battery story readback (s5 retest) ==" | tee "$FX/$C-battery.txt"
docker exec $C sh -c "$BAT_STATE" | grep -E "AC powered|USB powered|Wireless powered|status|level|voltage|temperature|present|Level|Voltage|Temperature|Present|Status|Charging|Overrides" >> "$FX/$C-battery.txt" 2>&1

echo "== webview CDP probe (gl unmasked + canvas hash + WebRTC ICE) ==" | tee "$FX/$C-webview.log"
$ADB -s $S shell "am force-stop org.chromium.webview_shell" >/dev/null 2>&1
sleep 1
$ADB -s $S shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d 'data:text/html,<h1>boot</h1>'" >/dev/null 2>&1
sleep 3
PID=$($ADB -s $S shell pidof org.chromium.webview_shell | tr -d '\r')
echo "webview pid=$PID" | tee -a "$FX/$C-webview.log"
$ADB -s $S forward --remove-all >/dev/null 2>&1
$ADB -s $S forward tcp:$HP localabstract:webview_devtools_remote_$PID >/dev/null
node /home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth-fix2/s1/fx-cdp.mjs $HP "$FX/$C-cdp.json" 2>&1 | tee -a "$FX/$C-webview.log"
docker exec $C sh -c 'dumpsys SurfaceFlinger 2>/dev/null | grep -i -m1 "GLES:"' >> "$FX/$C-props-gl.txt" 2>&1
echo "ALL DONE $C $(date -Is)"
