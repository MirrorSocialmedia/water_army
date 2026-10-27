#!/usr/bin/env bash
# J8 — 24h soak recorder (runbook J8). Snapshots fleet health on an interval
# and builds the soak table + signal summary. Observation template (loss /
# risk-control signals) is generated for humans to fill — an UNRECORDED signal
# is the failure, not the signal itself.
#
# Usage: nohup scripts/acceptance/j8-soak.sh --hours 24 --interval-min 15 &
# Env:   WA_ACCEPT_ADMIN_*. Idempotent: appends snapshots; table regenerated
#        from snapshots each loop (rerunnable; safe to kill/restart).
source "$(dirname "$0")/common.sh"
j_init j8
HOURS=24; INTERVAL=15
while [ $# -gt 0 ]; do case "$1" in --hours) HOURS="$2"; shift 2;; --interval-min) INTERVAL="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
login_admin
SNAPDIR="$(ev_path snapshots)"; mkdir -p "$SNAPDIR"
OBS="$(ev_path observations.md)"
[ -f "$OBS" ] || cat > "$OBS" <<'EOF'
# J8 觀察記錄表（人工逐日填）

> 風控訊號 ≠ FAIL；**未記錄先係 FAIL**。帳號死亡（DEAD）必帶 failureCode + 審計鏈 — 缺碼 = 記錄缺損 = 驗收未夠。

| 身份 | 平台 | 風控訊號（captcha/驗證/限流/異常彈窗） | 損耗（DEAD/降權） | 處置 | 結果 |
|------|------|--------------------------------------|------------------|------|------|
| redroid-acc-01 | Gmail(App)/FB/IG/Threads | | | | |
| redroid-acc-02 | | | | | |
| ... (10 身份 × 平台逐行) | | | | | |
EOF
API="$WA_API_URL/api"
end=$(( $(date +%s) + HOURS * 3600 ))
echo "soak start: ${HOURS}h every ${INTERVAL}min -> $SNAPDIR (kill to stop; rerun resumes appending)"
n=0
while [ "$(date +%s)" -lt "$end" ]; do
  n=$((n+1)); ts="$(date -Is)"; f="$SNAPDIR/snap-$(printf %05d "$n").json"
  {
    echo "{\"ts\":\"$ts\","
    echo "\"metrics\": $(curl -fsS -b "$ADMIN_JAR" --max-time 20 "$API/batches/metrics" 2>/dev/null | jq -c '{alerts:[.alerts[]?|{severity,code}], network_health_failures_total}' || echo '"unavailable"'),"
    echo "\"dashboard\": $(curl -fsS -b "$ADMIN_JAR" --max-time 20 "$API/dashboard/summary" 2>/dev/null | jq -c '{taskRuns:{active:(.taskRuns.active // null)}, notifications:(.notifications.unread)}' || echo '"unavailable"'),"
    echo "\"interventions_open\": $(curl -fsS -b "$ADMIN_JAR" --max-time 20 "$API/manual-interventions?status=open" 2>/dev/null | jq -c '{total}' || echo '"unavailable"'),"
    echo "\"devices\": $(curl -fsS -b "$ADMIN_JAR" --max-time 30 "$API/devices/redroid" 2>/dev/null | jq -c --arg p "$ACC_PREFIX" '[.devices[]|select(.name|startswith($p))|{name,containerState,adbState,net:(.proxy.network.state // null),netReady:(.proxy.network.networkReady // false)}]' || echo '"unavailable"')"
    echo "}"
  } > "$f" 2>/dev/null || true
  # soak table (device × time health matrix) rebuilt from snapshots — jq pivot
  jq -s -r '(["time"] + ([.[0].devices[]?.name] // [])) as $h | ($h | @tsv),
    (.[] | select(.devices | type=="array") | ([.ts] + ([.devices[] | (.adbState // "?") + "/" + (.net // "?")])) | @tsv)' \
    "$SNAPDIR"/snap-*.json > "$(ev_path soak-table.tsv)" 2>/dev/null || true
  # critical alert tripwire (fail-closed note — does not kill the recorder)
  crit="$(jq -r '[.alerts[]? | select(.severity=="critical")] | length' "$f" 2>/dev/null || echo 0)"
  [ "${crit:-0}" -gt 0 ] && echo "$(date -Is) CRITICAL alerts present — investigate (snap-$n)" | tee -a "$(ev_path alerts.log)"
  sleep $(( INTERVAL * 60 ))
done
echo "soak window complete ($n snapshots) — fill observations.md, then run J9"
