#!/usr/bin/env bash
# EXP-2 (docs/l3-play-integrity.md §3.1) — MTG checkin root-cause capture.
# Real-device leg on rdev-c1 (gms-mtg, port 16512). Evidence: logs/l3c-arm/exp2/.
# Secrets discipline: security_token / android_id-token values masked on write.
set -eu
ROOT=/home/kenneth/.openclaw/workspace/water_army
# EXP-2b: EVID_DIR/DEV overridable for proxy re-run (rdev-e1); defaults keep EXP-2 (rdev-c1).
EVID="${EVID_DIR:-$ROOT/logs/l3c-arm/exp2}"; mkdir -p "$EVID"
DEV="${DEV:-127.0.0.1:16512}"
ADB="$HOME/.local/share/platform-tools/adb"
D() { echo "[exp2] $(date -u +%FT%TZ) $*" | tee -a "$EVID/harness.log"; }
mask() { sed -E 's/((security[_-]?token|checkin[_-]?token|oauth[_-]?token)[\"'"'"':= ]{1,3})[A-Za-z0-9+\/=_-]{6,}/\1MASKED/gI'; }
SHELL_() { $ADB -s "$DEV" shell "$@"; }

collect() { # $1 = phase tag
  local p="$1"
  D "collect phase=$p"
  SHELL_ 'settings get secure android_id' > "$EVID/$p-settings-androidid.txt" 2>&1 || true
  SHELL_ 'content query --uri content://com.google.android.gsf.gservices 2>&1 | head -40' > "$EVID/$p-gservices.txt" 2>&1 || true
  SHELL_ 'ls -la /data/data/com.google.android.gsf/databases/ 2>&1; sqlite3 /data/data/com.google.android.gsf/databases/gservices.db "select name,value from main.overrides where name like \"%android_id%\" or name like \"auto%\";" 2>&1' > "$EVID/$p-gsf-db.txt" 2>&1 || true
  SHELL_ 'logcat -d' 2>/dev/null | mask > "$EVID/$p-logcat-full.txt" || true
  grep -iE "checkin|check-in|android_?id|consistency|phenotype|29504|GservicesChecker|DeviceConfigMgr|CheckinService|SecurityToken|GmsCoreCheckin|RegisterDevice" "$EVID/$p-logcat-full.txt" > "$EVID/$p-logcat-checkin.txt" 2>/dev/null || true
  SHELL_ 'dumpsys activity broadcasts history 2>/dev/null | grep -iE "checkin|android_id" | head -20' > "$EVID/$p-broadcasts.txt" 2>&1 || true
  SHELL_ 'ps -A | grep -E "gms|vending|gsf" ' > "$EVID/$p-procs.txt" 2>&1 || true
  local n; n=$(wc -l < "$EVID/$p-logcat-checkin.txt" 2>/dev/null || echo 0)
  local aid; aid=$(cat "$EVID/$p-settings-androidid.txt" | tr -d '\r')
  D "collect done phase=$p checkin_lines=$n secure_android_id=$aid"
}

case "${1:-}" in
boot-wait)
  for i in $(seq 1 60); do [ "$(SHELL_ getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 2; done
  D "boot_completed=$($ADB -s $DEV shell getprop sys.boot_completed | tr -d '\r')"
  ;;
phase1)
  D "first-boot observation window (90s for GMS checkin attempts)"
  sleep 90
  collect p1-firstboot
  ;;
phase2)
  D "pm clear com.google.android.gms -> re-checkin observation"
  SHELL_ 'pm clear com.google.android.gms' | tee "$EVID/p2-pmclear.txt"
  # framework services order: restart gms via monkey-style starter + force gsfs
  SHELL_ 'am broadcast -a android.intent.action.BOOT_COMPLETED -p com.google.android.gms' >/dev/null 2>&1 || true
  SHELL_ 'am startservice -n com.google.android.gms/.checkin.CheckinService' >/dev/null 2>&1 || true
  SHELL_ 'dumpsys deviceidle whitelist +com.google.android.gms' >/dev/null 2>&1 || true
  D "waiting 120s for re-checkin attempts"
  sleep 120
  collect p2-afterclear
  SHELL_ 'settings get secure android_id' > "$EVID/p2-androidid-recheck.txt" 2>&1 || true
  D "post-clear secure_android_id=$(cat "$EVID/p2-androidid-recheck.txt" | tr -d '\r')"
  ;;
attest)
  D "install + run wa-attest.apk (EXP-3 collector)"
  $ADB -s $DEV install -r -g "$ROOT/attest-app/dist/wa-attest.apk" 2>&1 | tail -1 | tee "$EVID/attest-install.txt"
  SHELL_ 'logcat -c' || true
  SHELL_ 'am start-activity -n com.waterarmy.attest/.AttestActivity' > "$EVID/attest-start.txt" 2>&1 || true
  D "waiting for attest probes (up to 150s: 45s x2 task awaits + margins)"
  for i in $(seq 1 30); do
    sleep 5
    if [ -n "$($ADB -s $DEV shell logcat -d -s WA-INTEGRITY 2>/dev/null | grep '"probe":"summary"')" ]; then break; fi
  done
  $ADB -s $DEV shell logcat -d -s WA-INTEGRITY 2>/dev/null | mask > "$EVID/attest-logcat.txt" || true
  $ADB -s $DEV shell cat /data/local/tmp/wa-attest-result.json 2>/dev/null | mask > "$EVID/attest-result.json" || true
  D "attest evidence: attest-logcat.txt attest-result.json"
  ;;
*) echo "usage: $0 boot-wait|phase1|phase2|attest"; exit 2;;
esac
