#!/bin/bash
# D1 batch probes on the 4 adv devices (host adb authority; gen1 adb = /home/kenneth/.local/share/platform-tools/adb)
ADB=/home/kenneth/.local/share/platform-tools/adb
D1=/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1
declare -A PORTS=( [a1]=15000 [a2]=15001 [a3]=15002 [a4]=15003 )
for dev in a1 a2 a3 a4; do
  S="$ADB -s 127.0.0.1:${PORTS[$dev]}"
  $S shell getprop > "$D1/getprop-$dev.txt" 2>&1
  $S shell "settings get secure android_id" | tr -d '\r' > "$D1/androidid-$dev.txt" 2>&1
  $S shell "ip link show; echo; ip addr show" > "$D1/iplink-$dev.txt" 2>&1
  $S shell dumpsys SurfaceFlinger > "$D1/surfaceflinger-$dev.txt" 2>&1
  $S shell "dumpsys SurfaceFlinger | grep -iE 'GLES|GL_RENDERER|GL_VENDOR|renderer|vendor' " > "$D1/sf-gl-$dev.txt" 2>&1
  $S shell "getprop | grep -iE 'gpu|gles|vulkan|opengl'" > "$D1/gpu-props-$dev.txt" 2>&1
  echo "== $dev done $(date -Is)"
done
