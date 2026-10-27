#!/usr/bin/env bash
# EXP-3 attest APK — offline AOSP-toolchain build (NO Gradle), mirror of
# probe-app/build.sh (stock JDK, hidden-API bootclasspath avoided).
# Client libs are pinned AARs from Google Maven (dl.google.com, boss-approved
# 直連) — classes.jar extracted to libs/. Fetch is cached (skip if present).
#   Usage:  ANDROID_HOME=/path/to/sdk bash attest-app/build.sh
#   Output: dist/wa-attest.apk
set -euo pipefail
cd "$(dirname "$0")"

# stock JDK17 + offline SDK live under workspace .android-tools (probe-app precedent)
WA_TOOLS=/home/kenneth/.openclaw/workspace/.android-tools
if [ -x "$WA_TOOLS/jdk-17.0.21+9/bin/javac" ]; then
  export JAVA_HOME="${JAVA_HOME:-$WA_TOOLS/jdk-17.0.21+9}"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
export ANDROID_HOME="${ANDROID_HOME:-$WA_TOOLS/sdk}"

SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
BT="$(ls -1 "$SDK/build-tools" 2>/dev/null | sort -V | tail -1)"
[ -n "$BT" ] || { echo "no build-tools under \$ANDROID_HOME" >&2; exit 1; }
BT="$SDK/build-tools/$BT"
PLATFORM="$SDK/platforms/android-34/android.jar"
[ -f "$PLATFORM" ] || { echo "missing platforms/android-34/android.jar" >&2; exit 1; }

# ---- pinned client libs (Google Maven) -------------------------------------
M=https://dl.google.com/dl/android/maven2
ARTIFACTS=(
  "com/google/android/play/integrity/1.6.0/integrity-1.6.0.aar"
  "com/google/android/play/core-common/2.0.4/core-common-2.0.4.aar"
  "com/google/android/gms/play-services-safetynet/18.0.1/play-services-safetynet-18.0.1.aar"
  "com/google/android/gms/play-services-base/18.0.1/play-services-base-18.0.1.aar"
  "com/google/android/gms/play-services-basement/18.9.0/play-services-basement-18.9.0.aar"
  "com/google/android/gms/play-services-tasks/18.2.0/play-services-tasks-18.2.0.aar"
  # plain JAR (not AAR): safetynet client runtime dep (androidx.collection.ArraySet)
  "androidx/collection/collection/1.0.0/collection-1.0.0.jar"
)
mkdir -p libs
for a in "${ARTIFACTS[@]}"; do
  base="$(basename "$a")"
  f="libs/${base%.aar}"; f="${f%.jar}"
  f_ext="${a##*.}"
  [ "$f_ext" = "aar" ] && f="$f.jar" || f="$f.$f_ext"
  [ -f "$f" ] && continue
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  curl -sf --max-time 120 -o "$tmp/pkg" "$M/$a" || { echo "fetch failed: $a" >&2; exit 1; }
  if [ "$f_ext" = "aar" ]; then
    unzip -q -o "$tmp/pkg" classes.jar -d "$tmp"
    cp "$tmp/classes.jar" "$f"
  else
    cp "$tmp/pkg" "$f"
  fi
done
trap - RETURN

# ---- compile -----------------------------------------------------------------
KEY=debug.keystore
if [ ! -f "$KEY" ]; then
  keytool -genkeypair -v -keystore "$KEY" -storepass android -keypass android \
    -alias wa-attest -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=water-army attest, OU=wa, O=wa, L=HK, C=HK" >/dev/null
fi

rm -rf build && mkdir -p build/obj build/apk
CP="$PLATFORM:$(ls -1 libs/*.jar | tr '\n' ':' | sed 's/:$//')"
# classpath compile (probe-app 5fe9ca1 precedent: stock JDK, no hidden-API bootclasspath)
javac -nowarn -source 11 -target 11 -classpath "$CP" \
  -d build/obj $(find src -name '*.java') 2>build/javac.log || { cat build/javac.log >&2; exit 1; }
[ -s build/javac.log ] && cat build/javac.log >&2

# ---- dex (ours + client libs) + package --------------------------------------
CP=()
for j in libs/*.jar; do CP+=(--classpath "$j"); done
"$BT/d8" --min-api 29 --lib "$PLATFORM" "${CP[@]}" --output build/apk \
  $(find build/obj -name '*.class') $(ls -1 libs/*.jar) 2>build/d8.log || { cat build/d8.log >&2; exit 1; }

"$BT/aapt2" link -o build/attest.unsigned.apk -I "$PLATFORM" --manifest AndroidManifest.xml
zip -j build/attest.unsigned.apk build/apk/classes.dex >/dev/null
"$BT/zipalign" -f 4 build/attest.unsigned.apk build/attest.aligned.apk
mkdir -p dist
"$BT/apksigner" sign --ks "$KEY" --ks-pass pass:android --key-pass pass:android \
  --out dist/wa-attest.apk build/attest.aligned.apk
echo "built dist/wa-attest.apk"
echo "run:  adb shell am start-activity -n com.waterarmy.attest/.AttestActivity"
echo "dump: adb logcat -d -s WA-INTEGRITY   |  adb shell cat /data/local/tmp/wa-attest-result.json"
