#!/bin/bash
# WA-RESCAN S2 ICE probe runner: bash docs/audits/rescan/scripts/run-ice.sh <label> [policy]
set -u
ADB=/home/kenneth/.openclaw/workspace/tools/platform-tools/adb
S=127.0.0.1:15002
EV=/home/kenneth/.openclaw/workspace/water_army/docs/audits/rescan/evidence
SCRIPT=/home/kenneth/.openclaw/workspace/water_army/docs/audits/rescan/scripts/ice-probe.cjs
LABEL="${1:?label}"
POLICY="${2:-}"

# policy empty -> no webview-command-line file (image default); else write it.
if [ -z "$POLICY" ]; then
  $ADB -s $S shell "rm -f /data/local/tmp/webview-command-line"
  $ADB -s $S shell "rm -f /data/local/tmp/chrome-command-line"
else
  ARGS="--webrtc-ip-handling-policy=$POLICY"
  $ADB -s $S shell "printf '%s' 'webview $ARGS' > /data/local/tmp/webview-command-line"
  $ADB -s $S shell "chmod 644 /data/local/tmp/webview-command-line"
fi

$ADB -s $S shell am force-stop org.chromium.webview_shell
sleep 1
$ADB -s $S shell "am start -n org.chromium.webview_shell/.WebViewBrowserActivity -a android.intent.action.VIEW -d about:blank" >/dev/null
sleep 4
SOCK=$($ADB -s $S shell "cat /proc/net/unix" | grep -o "webview_devtools_remote_[0-9]*" | head -1)
echo "devtools socket: $SOCK"
$ADB -s $S forward tcp:9323 "localabstract:$SOCK"
node "$SCRIPT" http://127.0.0.1:9323 "$LABEL"
