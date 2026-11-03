# WA-FIXALL S6 — gms-mtg-oemprop-stealth5 (stealth4-next bundle, COPY-only).
# Base: stealth4 (current S2 ship). No RUN / no network (same contract as the
# stealth4 chain — everything lands as bytes from the build context).
#
# Bundle (docs/audits/fixall/s6/S6-PLAN.md; risk-ledger R41/R43/R57-R59):
#   1) /system/product/app/webview/webview.apk  R41 root: x86-32 MTG engine ->
#      com.google.android.webview 156.0.8078.47 universal (arm64-v8a +
#      armeabi-v7a libs only -> primaryCpuAbi arm64-v8a via ndk_translation,
#      navigator.platform armv81). 262 MB, gitignored; sha pin in build.sh.
#   2) .wh.oat whiteout — old dex2oat artifacts are for the replaced apk.
#   3) /system/xbin/.wh.su whiteout — R43 "no su" (su binary ships in
#      /system/xbin on the MTG base; consumer story = absent).
#   4) /system/build.prop — single-line change ro.debuggable=1 -> 0 (R43;
#      diff asserted 1-line in build.sh; adb story: adbd goes secure).
#   5) /vendor/etc/health-fake/battery/* + stealth5-extras.rc — R59 battery
#      EXTRA skin: static fake power_supply psy bind-mounted over the empty
#      sysfs dir at post-fs-data (healthd example HAL reads sysfs paths).
#   6) stealth5-extras.rc also carries gsm.sim.state=ABSENT (R42 detail).
# Deliberately NOT in this bake: sensors fake HAL (no trustworthy x86_64
# Android-14 HAL prebuilt on this host — honestly deferred, see S6-RESULTS);
# ro.build.type/tags = fingerprint-derived boot args (profile data, not image).
FROM water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth4

COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/vendor/webview-1560807847-arm64.apk /system/product/app/webview/webview.apk
COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/whiteouts/webview-oat.wh /system/product/app/webview/.wh.oat
COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/whiteouts/su.wh /system/xbin/.wh.su
COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/system/build.prop /system/build.prop
COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/vendor/etc/health-fake/battery/ /vendor/etc/health-fake/battery/
COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/vendor/etc/init/stealth5-extras.rc /vendor/etc/init/stealth5-extras.rc
