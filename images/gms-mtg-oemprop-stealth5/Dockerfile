# WA-FIXALL S6 — gms-mtg-oemprop-stealth5 (stealth4-next bundle, COPY-only).
# Base: stealth4 (current S2 ship). No RUN / no network (same contract as the
# stealth4 chain — everything lands as bytes from the build context).
#
# Bundle (docs/audits/fixall/s6/S6-PLAN.md; risk-ledger R41/R43/R57-R59):
#   1) R41 WebView swap REVERTED before ship (measured S6, fresh-data fx2):
#      the vendored com.google.android.webview 156 universal APK ships arm64
#      libs only, but this image family's native bridge is libnb.so — the
#      NO-OP null bridge (getprop ro.dalvik.vm.native.bridge = libnb.so; no
#      libndk_translation binary, no nativetranslate APEX). With the swap in
#      place PackageManager registers the apk (abilist64 carries arm64-v8a)
#      yet the arm64 libwebviewchromium.so cannot dlopen => WebViewFactory
#      "No WebView installed" = webview dead on-device. R41 needs the full
#      translator trifecta (real translator .so + bridge prop + abilist) =
#      image-level work deferred to the next bake; the vendored APK + pin
#      stay in images/gms-mtg-oemprop-stealth5/vendor/ ready for it.
#   2) .wh.oat whiteout — old dex2oat artifacts are for the replaced apk.
#   3) /system/xbin/.wh.su whiteout — R43 "no su" (su binary ships in
#      /system/xbin on the MTG base; consumer story = absent).
#   4) /vendor/etc/init/oem-ro-map.rc — regenerated 13-entry carrier table
#      (R50 locale->ro.product.locale row from c98b211: the stealth4 image
#      shipped the 12-entry table, so the locale carrier spun in the air
#      on-device = measured). Generated artifact of
#      images/redroid-w1b/oem-ro-map-stealth.rc (CI drift guards apply).
#   5) /vendor/etc/health-fake/battery/* + stealth5-extras.rc — R59 battery
#      EXTRA skin: static fake power_supply psy bind-mounted over the empty
#      sysfs dir at post-fs-data (healthd example HAL reads sysfs paths).
#   6) stealth5-extras.rc also carries gsm.sim.state=ABSENT (R42 detail).
# REVERTED mid-S6 (measured): ro.debuggable=0 via /system/build.prop — the
# single flipped line KILLS init on redroid (exit 129 ~7 s; adbd is an init
# `critical` service and the platform's whole management arm is adb), so the
# consumer debuggable=0 story is not viable here; debuggable stays 1
# (documented deviation, see build-record.md).
# Deliberately NOT in this bake: sensors fake HAL (no trustworthy x86_64
# Android-14 HAL prebuilt on this host — honestly deferred, see S6-RESULTS);
# ro.build.type/tags = fingerprint-derived boot args (profile data, not image).
FROM water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth4

COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/whiteouts/su.wh /system/xbin/.wh.su
COPY --chown=0:0 images/redroid-w1b/oem-proc-view.sh /vendor/bin/oem-proc-view.sh
COPY --chown=0:0 images/redroid-w1b/oem-proc-view.rc /vendor/etc/init/oem-proc-view.rc
COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/vendor/etc/init/oem-ro-map.rc /vendor/etc/init/oem-ro-map.rc
COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/vendor/etc/health-fake/battery/ /vendor/etc/health-fake/battery/
COPY --chown=0:0 images/gms-mtg-oemprop-stealth5/files/vendor/etc/init/stealth5-extras.rc /vendor/etc/init/stealth5-extras.rc
