# WA-FIX2B (R2) build record — gms-mtg-oemprop-stealth3

- Built: 2026-10-29 (gen1), image `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth3`
- Base (digest-pinned): `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2`
  = `sha256:6e31ac98e14378d8cf5b7ca7774e13b07cdddb7ebfc7b0049e6fa7bb520b48d8`
- Layer: ONE file — `/vendor/lib64/dri/libgallium_dri.so` (the fat gallium every
  `*_dri.so` symlinks to). Base sha `0f32f9e8…`; patched sha pin
  `ab402d24e7acf862bf62ac0763b6ac6557418e8d070c126fefb69ac205fe33ac`; size
  unchanged 35,444,760 B (NUL-pad in-place, zero layout change).

## Ops (patch_cstr.mjs, fail-closed exact counts)
1. renderer suffix `"%s (radeonsi, %s%s, DRM %i.%i%s)"` → `"%s"` (kills
   radeonsi + chip + ACO + DRM + host kernel line in GL_RENDERER)
2. GL_VERSION `"%s%u.%u%s Mesa 24.0.8 (git-441f064c1c)"` → `"%s%u.%u%s V@0615"`
   (Adreno-style; kills "Mesa")
3. vendor `"AMD"` → `"ARM"` ×130 standalone NUL-terminated (kills GL_VENDOR
   "AMD"; mobile-plausible token; driver matching keys on uevent DRIVER=amdgpu,
   untouched). Base already had 13 standalone "ARM" → in-image ARM = base+130.

## RESIDUAL (documented, measured — not "patched = fixed")
- Renderer PREFIX "AMD Radeon Graphics" = amdgpu firmware sku string returned
  by the DRM ioctl (host kernel/firmware side; 0 hits for that string in every
  image file). It is host-firmware-scoped (same host → same prefix), NOT
  per-device identifying; full kill needs ANGLE-on-Vulkan EGL (ro.hardware.egl
  = angle — gpu_config host branch still `mesa`; big behaviour change, needs
  real-device verdict before fleet) or per-boot /sys bind. Boss verdict input.
- Extension LISTS still carry GL_MESA_*/GL_AMD_* names (not vendor/renderer/
  version strings; browserleaks/chrome://gpu readouts target the strings).

## Verdict discipline
Real-device reads required (fx-2+): dumpsys GLES line + webview CDP
gl/WebGL unmasked strings. This record + asserts ≠ verdict.
