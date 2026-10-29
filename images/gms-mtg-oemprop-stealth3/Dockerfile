# water_army WA-FIX2B — gms-mtg-oemprop-stealth2 + host-GLES cstr layer (R2)
#
# Base: water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2 (vulkan
# lvp + deviceName "Adreno (TM) 644" + gpu_config 7/7 lvp). This image adds
# ONLY the GLES-face string patch:
#
#   /vendor/lib64/dri/libgallium_dri.so — patched (patch-ops.mjs, pinned
#   counts): renderer suffix format -> "%s"; GL_VERSION format -> Adreno-style
#   "V@0615"; vendor "AMD" -> "ARM" (130x). Kills radeonsi/chip/ACO/DRM/host
#   kernel + "Mesa" + "AMD" vendor from the Mesa GLES face (dumpsys
#   SurfaceFlinger GLES line + any native glGetString). Residual: renderer
#   prefix "AMD Radeon Graphics" = amdgpu FIRMWARE sku string via DRM ioctl
#   (kernel-side; not an image string — see fix2b report R2 residual).
#
# Determinism: build.sh extracts + patches from the digest-pinned base and
# COPYs the patched file (byte-identical reruns); COPY-only, no RUN, no
# network. Secrets: NONE.

FROM water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2
COPY --chown=0:0 images/gms-mtg-oemprop-stealth3/patches/libgallium_dri.so /vendor/lib64/dri/libgallium_dri.so
