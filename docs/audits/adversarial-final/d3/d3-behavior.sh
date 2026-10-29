#!/bin/bash
# D3-3: product-style injection ×20 sessions + mechanical baseline ×10 on real device a1.
# Kernel getevent NOT VERIFIED (see getevent-probe.txt); this measures the product command
# signature end-to-end (host wall-clock per injection) vs mechanical control.
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
ADB=/home/kenneth/.local/share/platform-tools/adb
S=127.0.0.1:15000
IN(){ $ADB -s $S shell "$@" >/dev/null 2>&1; }
ts(){ date +%s.%N; }
: > behavior.log
for i in $(seq 1 20); do
  # product-style micro-swipe (1px,120ms fixed, per account-signup-steps.js:106) + 2 taps + burst text
  t0=$(ts); IN input swipe 640 1150 640 1149 120; t1=$(ts)
  IN input tap 540 900; t2=$(ts)
  IN input tap 120 1600; t3=$(ts)
  IN input text 'abc123'; t4=$(ts)
  echo "S$i $t0 $t1 $t2 $t3 $t4" | awk '{printf "PROD %s swipe=%.3f tap1=%.3f tap2=%.3f text=%.3f\n",$1,$3-$2,$4-$3,$5-$4,$6-$5}' >> behavior.log
  sleep 1.5
done
: > humanref.log
# Human-likeness contrast ("driving 對照"): variable paths/durations/coords/per-key gaps
for i in $(seq 1 10); do
  x1=$(( (RANDOM%40)-20+640 )); y1=$(( (RANDOM%40)-20+1150 ))
  d=$(( (RANDOM%281)+120 ))
  t0=$(ts); IN input swipe "$x1" "$y1" "$((x1+RANDOM%5))" "$((y1-1-RANDOM%3))" "$d"; t1=$(ts)
  IN input tap "$(( (RANDOM%900)+80 ))" "$(( (RANDOM%1800)+200 ))"; sleep 0.$(( (RANDOM%7)+2 )); t2=$(ts)
  IN input tap "$(( (RANDOM%900)+80 ))" "$(( (RANDOM%1800)+200 ))"; t3=$(ts)
  for ch in a b c 1 2 3; do IN input text "$ch"; sleep 0.$(( (RANDOM%42)+8 )); done; t4=$(ts)
  echo "H$i $t0 $t1 $t2 $t3 $t4" | awk -v d="$d" '{printf "HUMANREF %s swipe=%.3f(dur=%s) tap1=%.3f tap2=%.3f text6chars=%.3f\n",$1,$3-$2,d,$4-$3,$5-$4,$6-$5}' >> humanref.log
  sleep 2
done
# device-side landing proof: screencap before/after a tap on known UI change (best effort: surface flinger touch counters)
$ADB -s $S shell "dumpsys input | grep -iE 'touch|event.*count|RecentQueue' | head -6" > input-counters.txt 2>&1
echo BEHAVIOR_DONE
