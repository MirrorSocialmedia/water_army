# WA-FIX2B R2 — GLES/glGetString string research + stealth3 patch

Boss ruling 2026-10-29 22:15: GLES 字串即刻修唔准拖;R2 先測再補,判語 = 真機讀值。

## 修前（measured, not assumed）
- Native GLES face (gpu_mode=host, ro.hardware.egl=mesa — gpu_config-stealth2
  line 70 host branch): dumpsys SurfaceFlinger GLES line on a bootable
  stealth2 container (fix2b-gltest probe, 2026-10-29):
  `AMD, AMD Radeon Graphics (radeonsi, raphael_mendocino, ACO, DRM 3.57, 6.8.0-117-generic), OpenGL ES 3.2 Mesa 24.0.8 (git-441f064c1c)`
  — same shape as fx-1 s1 evidence (docs/audits/stealth-fix2/s1/).
- Vulkan face: ALREADY fixed in stealth2 (deviceName "Adreno (TM) 644" +
  ro.hardware.vulkan=lvp; s3/s5 evidence). Webview WebGL = ANGLE-on-Vulkan →
  chrome://gpu unmasked verdict awaits fx-2 (boss hint: may already eat s3).

## Carrier findings (measured)
- `GPU_VERSION` env: DEAD. (a) container Env never reaches Android services
  (fix2b-gltest: shell had it, `/proc/<surfaceflinger>/environ` did NOT);
  (b) Mesa loader name path not env-driven here anyway.
- Renderer prefix "AMD Radeon Graphics": 0 hits across image files
  (`grep -rl` /vendor/lib64 /vendor/lib64/egl /vendor/lib64/dri /system/lib64)
  and 0 host sysfs files under /sys/class/drm/card1/device/ — it is the
  amdgpu FIRMWARE sku string returned via DRM ioctl (card1 = PCI 1002:13C0).
  Not patchable in image; host-firmware-scoped (same host constant, not
  per-device).
- Standalone `"AMD\0"` in `/vendor/lib64/dri/libgallium_dri.so` = 130 (GL_VENDOR
  "AMD" + loader/pci display tables; driver matching keys on uevent
  DRIVER=amdgpu — untouched). Base already carries 13 standalone `"ARM\0"`.

## stealth3 patch (image layer, fail-closed asserts in build.sh)
File: `/vendor/lib64/dri/libgallium_dri.so` (one fat gallium; all `*_dri.so`
are symlinks). Ops via scripts/stealth/patch_cstr.mjs:
1. `"%s (radeonsi, %s%s, DRM %i.%i%s)"` → `"%s"` (kills radeonsi/chip/ACO/DRM/kernel)
2. `"%s%u.%u%s Mesa 24.0.8 (git-441f064c1c)"` → `"%s%u.%u%s V@0615"` (kills Mesa; Adreno-style V@)
3. `"AMD"` → `"ARM"` ×130 (kills GL_VENDOR AMD; ARM = real Android GL vendor token)

Pinned: base lib sha `0f32f9e8…`, patched sha `ab402d24…`, size 35,444,760 B
unchanged. Expected post reads (VERDICT STILL = fx-2 real device):
GL_VENDOR "ARM", GL_RENDERER "AMD Radeon Graphics" (prefix residual),
GL_VERSION "OpenGL ES 3.2 V@0615".

## Residual (honest)
- "AMD Radeon Graphics" prefix (firmware sku) → not mobile-plausible but not
  per-device-identifying; full kill options: ro.hardware.egl=angle (behaviour
  change — needs real-device FPS/stability verdict before fleet) or per-boot
  bind of /sys entries (does not apply: ioctl string, not a file).
- GL extension lists still carry GL_MESA_*/GL_AMD_* names (extensions, not the
  vendor/renderer/version readouts).
