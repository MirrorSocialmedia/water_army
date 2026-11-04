# WA-STEALTH6 stealth6-v1 (base stealth5, COPY-only — same contract as the
# stealth4/5 chain: everything lands as bytes from the build context).
#
# Bundle (workorder WA-STEALTH6 gen2; T1 field proof
# docs/audits/stealth6/t1-abi-field-test.md; T2 design
# docs/audits/stealth6/t2-sensorhal-options.md):
#   1) T1: abi -> arm64-primary prop rows (stealth6-extras.rc, boot-contract
#      phase load_persist_props_action). STRUCTURAL: x86_64 stays in the
#      abilist tail (removal = zygote fork death on stale packages.xml
#      primaryCpuAbi — gen1 field-proven). Supersedes the gen1 fx2 probe rc
#      (container-FS only; gone on recreate).
#   2) T2: wa-sensors — minimal userland AIDL sensors HAL (self-built
#      android.hardware.sensors-service.example, host-built against the base
#      image's own generated lib; 3 fixed sensors accel/gyro/proximity),
#      VINTF manifest-dir fragment merge + init service stanza.
# No RUN / no network. Modes enforced in build.sh (init insecure-file rule).
FROM water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth5

COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/etc/init/stealth6-extras.rc /vendor/etc/init/stealth6-extras.rc
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/etc/init/android.hardware.sensors-service.example.rc /vendor/etc/init/android.hardware.sensors-service.example.rc
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/etc/vintf/manifest/android.hardware.sensors.xml /vendor/etc/vintf/manifest/android.hardware.sensors.xml
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/bin/hw/android.hardware.sensors-service.example /vendor/bin/hw/android.hardware.sensors-service.example
# Generated AIDL-NDK runtime libs: /system/lib64-only in the base, not
# reachable from the vendor linker namespace -> vendor copies (bytes from
# the same base image; keeps wa-sensors self-contained in /vendor).
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/lib64/android.hardware.sensors-V2-ndk.so /vendor/lib64/android.hardware.sensors-V2-ndk.so
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/lib64/android.hardware.common-V2-ndk.so /vendor/lib64/android.hardware.common-V2-ndk.so
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/lib64/android.hardware.common.fmq-V1-ndk.so /vendor/lib64/android.hardware.common.fmq-V1-ndk.so
# T3 network: eth0->wlan0 rename at init + ipconfig.txt binary patch (stealth6-v2)
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/etc/init/stealth6-network.rc /vendor/etc/init/stealth6-network.rc
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/bin/stealth6-network.sh /vendor/bin/stealth6-network.sh
# SCR.apk: patch config_ethernet_iface_regex eth\d -> w.*\d (same-length 5-char, signing block preserved)
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/system/apex/com.android.tethering/priv-app/ServiceConnectivityResources@UD2A.240505.001.W1/ServiceConnectivityResources.apk /system/apex/com.android.tethering/priv-app/ServiceConnectivityResources@UD2A.240505.001.W1/ServiceConnectivityResources.apk
# Proximity feature XML (required for SensorManager.hasSystemFeature(SENSOR_PROXIMITY))
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/vendor/etc/permissions/android.hardware.sensor.proximity.xml /vendor/etc/permissions/android.hardware.sensor.proximity.xml
# gen11 T5 (stealth6-v3 batch 1): maps-shim bake — the two gen10 container-layer files
# (lost on container recreate) become image bytes. shim.so = LD_PRELOAD /proc/self/maps
# rwx-line filter (clears DevCheck "native cross-check wx_segment" -15; field-proven
# on fx2, score 82->97). init.redroid.rc = FULL official zygote service definition +
# setenv LD_PRELOAD (scope: framework processes only; a bare duplicate drops class/sockets
# and zygote never starts — first definition wins, imported before init.zygote64.rc).
# Source + host build: images/gms-mtg-oemprop-stealth6/shim/build_shim.sh
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/system/lib64/shim.so /system/lib64/shim.so
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/init.redroid.rc /init.redroid.rc
# gen11 T5 (stealth6-v3 batch 2, boss decision #4): debuggable re-attack — field-proven on
# fx2: ro.debuggable=0 boots healthy (12s), adbd alive (it is class core/disabled/override,
# NOT critical — the old S6 death was the user-build AUTH gap: without /data/misc/adb/adb_keys
# provisioning the control line shows 'unauthorized', not a crash). Story aligns to
# ro.build.type=user (effective value was already user via oem-persist; file bytes aligned
# for raw-file consistency). DevCheck re-scan 97/100 no regression, 'ro.debuggable mismatch'
# line gone. Ops: fleet must seed /data/misc/adb/adb_keys (host adbkey.pub) on user builds.
COPY --chown=0:0 images/gms-mtg-oemprop-stealth6/files/system/build.prop /system/build.prop
