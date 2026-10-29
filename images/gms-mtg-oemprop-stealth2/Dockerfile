# water_army WA-STEALTH-FIX2 — gms-mtg-oemprop-stealth + vulkan layer (s3)
#
# Base: water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth — the fleet
# stealth image (oemprop 12/12 chain + lavapipe deviceName patch + carrier
# sweep rc). This image adds ONLY the vulkan-selection layer:
#
#   /vendor/bin/gpu_config.sh   the host-GPU probe sets ro.hardware.vulkan
#       from the detected DRM driver (amdgpu → radeon …, swiftshader path →
#       pastel). s1 REAL-DEVICE ruling (docs/audits/stealth-fix2/s1/
#       S1-RESEARCH §2): this is the ONLY setter of ro.hardware.vulkan —
#       it wins the ro first-write race, so the env/carrier layer can never
#       move the property (fx-1: ro.hardware.vulkan=radeon while
#       ro.boot.oem_ro_hardware_vulkan=lvp sat UNCONSUMED). stealth2 forces
#       EVERY branch to lvp: the Vulkan HAL becomes lavapipe (already in the
#       base with its deviceName patched to "Adreno (TM) 644"), making the
#       vulkan-facing renderer string host-independent — the same phone-like
#       name on every host instead of "radeon/intel/pastel per machine".
#       GLES (WebView unmaskedRenderer) stays host Mesa = wave-2 KNOWN
#       LIMITATION (boss ruling; see fix2 report), NOT touched here.
#
# Determinism: committed artifact images/gms-mtg-oemprop-stealth2/
# gpu_config-stealth2.sh (sed transform of the pinned base file, 7/7 branches
# → lvp, sha256-pinned in build.sh); COPY-only layer, no RUN, no network.
# Secrets: NONE.

FROM water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth
COPY --chown=0:0 images/gms-mtg-oemprop-stealth2/gpu_config-stealth2.sh /vendor/bin/gpu_config.sh
