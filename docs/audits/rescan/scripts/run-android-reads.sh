#!/bin/bash
# WA-RESCAN S3: fx-3 Android-side leak reads (getprop 12, MAC, sensors, DNS, TZ, GLES).
set -u
ADB=/home/kenneth/.openclaw/workspace/tools/platform-tools/adb
S=127.0.0.1:15002
EV=/home/kenneth/.openclaw/workspace/water_army/docs/audits/rescan/evidence
C=redroid-rdev-fx-3
OUT=$EV/$C-android-reads.txt
{
  echo "=== getprop ro.* leak scan @ $(date -Is) ==="
  for p in ro.build.fingerprint ro.build.product ro.build.display.id ro.product.model ro.product.brand \
           ro.product.manufacturer ro.product.device ro.hardware ro.soc.model ro.soc.manufacturer \
           ro.boot.hardware ro.kernel.qemu gsm.version.baseband ro.gfx.driver.0; do
    printf '%s = %s\n' "$p" "$($ADB -s $S shell getprop $p 2>/dev/null | tr -d '\r')"
  done
  echo "=== TZ / locale / DNS ==="
  echo "persist.sys.timezone = $($ADB -s $S shell getprop persist.sys.timezone | tr -d '\r')"
  echo "locale = $($ADB -s $S shell settings get system 2>/dev/null | grep -m1 locale_override | tr -d '\r')"
  echo "net.dns = $($ADB -s $S shell getprop net.dns1 | tr -d '\r')"
  echo "resolv = $($ADB -s $S shell 'cat /etc/resolv.conf 2>/dev/null | grep -m2 nameserver' | tr '\n' ' ' | tr -d '\r')"
  echo "=== MAC (eth0 live) ==="
  $ADB -s $S shell "ip link show eth0 2>/dev/null | grep -m1 link/ether" | tr -d '\r'
  echo "settings secure wifi/mac = $($ADB -s $S shell settings get global wifi_mac_address | tr -d '\r')"
  echo "=== sensors (sensorservice summary) ==="
  $ADB -s $S shell "dumpsys sensorservice | head -6" | tr -d '\r'
  echo "sensor count: $($ADB -s $S shell "dumpsys sensorservice | grep -c '+ 0x'" | tr -d '\r')"
  echo "=== GLES (SurfaceFlinger) ==="
  $ADB -s $S shell "dumpsys SurfaceFlinger 2>/dev/null | grep -i -m1 'GLES:'" | tr -d '\r'
  echo "=== EGL strings (libGLESv2 count AMD) ==="
  $ADB -s $S shell "sh -c 'ls /vendor/lib64/eglesp_reg.h 2>/dev/null; strings /vendor/lib64/libGLESv2.so 2>/dev/null | grep -c AMD'" | tr -d '\r'
} | tee "$OUT"
