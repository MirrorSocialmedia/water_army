#!/usr/bin/env bash
# W1b probe APK — offline AOSP-toolchain build (NO Gradle, NO network).
# Requires an Android SDK build-tools dir; NOT built in the code segment
# (real-device stage owns build + install + dump). Expected output:
#   dist/wa-probe.apk  (debug-signed with the platform test key below)
#
# Usage:  ANDROID_HOME=/path/to/sdk bash probe-app/build.sh
set -euo pipefail
cd "$(dirname "$0")"

BT="${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools"
BT="$(ls -1 "$BT" 2>/dev/null | sort -V | tail -1)"
[ -n "$BT" ] || { echo "no build-tools under \$ANDROID_HOME — install SDK build-tools first (real-device stage step)" >&2; exit 1; }
BT="${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools/$BT"
PLATFORM="${ANDROID_HOME:-$HOME/Android/Sdk}/platforms/android-34/android.jar"
[ -f "$PLATFORM" ] || { echo "missing platforms/android-34/android.jar" >&2; exit 1; }

KEY=debug.keystore
if [ ! -f "$KEY" ]; then
  keytool -genkeypair -v -keystore "$KEY" -storepass android -keypass android \
    -alias wa-probe -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=water-army probe, OU=wa, O=wa, L=HK, C=HK" >/dev/null
fi

rm -rf build && mkdir -p build/gen build/obj build/apk
"$BT/aapt2" compile --dir res -o build/res.zip 2>/dev/null || true  # res/ optional
"$BT/aapt2" link -o build/probe.unsigned.apk \
  -I "$PLATFORM" \
  --manifest AndroidManifest.xml \
  $( [ -f build/res.zip ] && echo "-R build/res.zip" )

javac -source 11 -target 11 -bootclasspath "$PLATFORM" \
  -d build/obj $(find src -name '*.java')

"$BT/d8" --lib "$PLATFORM" --output build/apk $(find build/obj -name '*.class')
zip -j build/probe.unsigned.apk build/apk/classes.dex >/dev/null

"$BT/zipalign" -f 4 build/probe.unsigned.apk build/probe.aligned.apk
"$BT/apksigner" sign --ks "$KEY" --ks-pass pass:android --key-pass pass:android \
  --out dist/wa-probe.apk build/probe.aligned.apk 2>/dev/null || {
    mkdir -p dist && "$BT/apksigner" sign --ks "$KEY" --ks-pass pass:android \
      --key-pass pass:android --out dist/wa-probe.apk build/probe.aligned.apk
  }
echo "built dist/wa-probe.apk"
echo "install (real-device stage): adb install -r dist/wa-probe.apk"
echo "run:  adb shell am start-activity -n com.waterarmy.probe/.ProbeActivity"
echo "dump: adb shell cat /data/local/tmp/wa-probe-dump.json > probe-dump.json"
