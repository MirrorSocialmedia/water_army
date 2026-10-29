#!/bin/bash
# WA-STEALTH-FIX2 s1 — fx-1 real-device probe driver (single boot).
# Evidence -> docs/audits/stealth-fix2/s1/
set -u
# NOTE(2026-10-29 run): this pass pre-dated `adb connect` (first round's
# webrtc section failed on 'device not found'; webrtc evidence = the manual
# rounds webrtc-prop-public/file-public/settings-public.json + S1-RESEARCH §3).
ADB=/home/kenneth/.openclaw/workspace/tools/platform-tools/adb
S="127.0.0.1:15004"
$ADB connect $S >/dev/null 2>&1
C=redroid-rdev-fx-1
S1=/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth-fix2/s1
HP=9400

BAT_STATE='dumpsys battery | sed -n "s/\r//g"'

echo "== battery BEFORE ==" | tee "$S1/battery-before.txt"
docker exec $C sh -c "$BAT_STATE" | grep -E "AC powered|USB powered|Wireless powered|status|level|voltage|temperature|present|Level|Voltage|Temperature|Present|Status|Charging" >> "$S1/battery-before.txt" 2>&1

echo "== battery story apply (prod script + present 1 + plugged 0) ==" | tee "$S1/battery-after.txt"
docker exec $C sh -c 'dumpsys battery unplug; dumpsys battery set status 3; dumpsys battery set level 79; dumpsys battery set temperature 295; dumpsys battery set voltage 4120; dumpsys battery set present 1; dumpsys battery set ac 0; dumpsys battery set usb 0; dumpsys battery set wireless 0; echo BATSET_OK' | tee -a "$S1/battery-after.txt"
echo "-- readback --" >> "$S1/battery-after.txt"
docker exec $C sh -c "$BAT_STATE" | grep -E "AC powered|USB powered|Wireless powered|status|level|voltage|temperature|present|Level|Voltage|Temperature|Present|Status|Charging|Overrides" >> "$S1/battery-after.txt" 2>&1

echo "== props / GL ==" | tee "$S1/props-gl.txt"
docker exec $C sh -c 'getprop ro.hardware.vulkan; getprop ro.hwui.use_vulkan; getprop ro.board.platform; dumpsys SurfaceFlinger 2>/dev/null | grep -i -m1 "GLES:"; ls /vendor/lib64/hw/ | grep -i vulkan' >> "$S1/props-gl.txt" 2>&1

echo "== webview baseline probe ==" | tee "$S1/webview.log"
$ADB -s $S shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d 'data:text/html,<h1>boot</h1>'" >/dev/null 2>&1
sleep 3
P=$($ADB -s $S shell pidof org.chromium.webview_shell | tr -d '\r')
echo "webview pid=$P" | tee -a "$S1/webview.log"
$ADB -s $S forward tcp:$HP localabstract:webview_devtools_remote_$P >/dev/null
node $S1/fx-cdp.mjs $HP $S1/browser-fx1-lvp.json 2>&1 | tee -a "$S1/webview.log"
docker exec $C sh -c 'dumpsys SurfaceFlinger 2>/dev/null | grep -i -m1 "GLES:"' | tee "$S1/gles-after-webview.txt"

# --- WebRTC flag rounds (property mechanism; webview reload per round) ---
webrtc_round() {
  local name="$1" policy="$2"
  docker exec $C sh -c "setprop webviewcommandline '--webrtc-ip-handling-policy=$policy'; getprop webviewcommandline" > "$S1/webrtc-$name.prop.txt" 2>&1
  $ADB -s $S shell am force-stop org.chromium.webview_shell >/dev/null 2>&1
  sleep 2
  $ADB -s $S shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d 'data:text/html,<h1>boot</h1>'" >/dev/null 2>&1
  sleep 3
  P2=$($ADB -s $S shell pidof org.chromium.webview_shell | tr -d '\r')
  $ADB -s $S forward --remove-all >/dev/null 2>&1
  $ADB -s $S forward tcp:$HP localabstract:webview_devtools_remote_$P2 >/dev/null
  node $S1/fx-cdp.mjs $HP "$S1/webrtc-$name.json" webrtc-only >> "$S1/webview.log" 2>&1
  echo "$name done $(date -Is)" >> "$S1/webview.log"
}
echo "== webrtc policy rounds ==" | tee -a "$S1/webview.log"
webrtc_round pol-public default_public_interface_only
webrtc_round pol-disableudp disable_udp

echo "ALL DONE $(date -Is)"
