# water_army WA-VMSTEALTH — gms-mtg-oemprop + stealth layer (S2)
#
# Base: water-army/redroid:14.0.0-240527-gms-mtg-oemprop — the real-device-
# verified fingerprint chain image (WA-OEMPROP v4: 12/12 on device). This
# image adds ONLY the WA-VMSTEALTH layer:
#
#   /vendor/lib64/hw/vulkan.lvp.so   lavapipe with the Vulkan deviceName
#       "llvmpipe (git-53e769e0f1)" replaced IN PLACE by "Adreno (TM) 644"
#       (shorter-or-equal NUL-padded C-string patch — scripts/stealth/
#        patch_cstr.mjs, fail-closed on literal drift; file size
#        byte-identical). GPU/renderer tell per
#        docs/audits/vmstealth-s1-mechanism.md §1.4 ruling (a).
#   /vendor/etc/init/oem-ro-map.rc   the STEALTH mapping variant: base 12
#       targets + 50 derived stealth props + per-phase carrier sweep
#       (ro.boot.oem_* erased after consumption). GENERATED artifact —
#       images/redroid-w1b/oem-ro-map-stealth.rc, drift-guarded by
#       scripts/w1b/generate-wa-ro-map-rc.mjs --check.
#
# EXPLICITLY not included (S1 rulings): sensor HAL (VINTF/sepolicy = boot
# surface, WA-VMSTEALTH-2), fake battery sysfs (same class), libGLESv2_angle
# wrapper strings (pointer-referenced template, §1.3 risk note).
#
# Secrets: NONE (no LABEL/ENV in metadata). Every input sha256-pinned in
# build.sh; patched-binary determinism pinned post-build.
#
# Build (NOT a redroid boot — negligible RAM):
#   bash images/gms-mtg-oemprop-stealth/build.sh   <- THE entry point

# --- stage 1: fail-closed C-string patch of the lavapipe deviceName -------
# node:22-alpine — patcher is scripts/stealth/patch_cstr.mjs (no network).
FROM node:22-alpine AS lvp-patch
COPY --from=water-army/redroid:14.0.0-240527-gms-mtg-oemprop /vendor/lib64/hw/vulkan.lvp.so /build/vulkan.lvp.so
COPY scripts/stealth/patch_cstr.mjs /build/patch_cstr.mjs
RUN sha256sum /build/vulkan.lvp.so \
 && node /build/patch_cstr.mjs /build/vulkan.lvp.so "llvmpipe (git-53e769e0f1)" "Adreno (TM) 644" \
 && chmod 0644 /build/vulkan.lvp.so \
 && sha256sum /build/vulkan.lvp.so

# --- stage 2: image (COPY-only: the stock redroid base has no usable sh) ---
FROM water-army/redroid:14.0.0-240527-gms-mtg-oemprop
COPY --from=lvp-patch /build/vulkan.lvp.so /vendor/lib64/hw/vulkan.lvp.so
COPY images/redroid-w1b/oem-ro-map-stealth.rc /vendor/etc/init/oem-ro-map.rc
