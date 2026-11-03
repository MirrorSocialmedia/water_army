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
