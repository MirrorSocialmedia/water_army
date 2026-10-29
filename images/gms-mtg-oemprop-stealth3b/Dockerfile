# water_army WA-FIX2B — stealth3 hotfix layer R2b (stealth3b).
#
# Base: water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2 (digest
# sha256:6e31ac98…). Same three cstr ops as stealth3, with ONE correction
# proven on redroid-rdev-fx-2 (2026-10-29, bisect r1..r8):
#
#   1. renderer suffix  "%s (radeonsi, %s%s, DRM %i.%i%s)" -> "%s"
#   2. GL_VERSION fmt   "%s%u.%u%s Mesa 24.0.8 (git-441f064c1c)" -> "%s%u.%u%s V@0615"
#   3. vendor           "AMD" -> "IMG" on 129 of the 130 exact standalone
#      NUL-terminated cstrs — EXCEPT the gate string at file offset 1917602,
#      which stays "AMD".
#
# Why the exception: renaming that ONE string (130th AMD cstr family,
# index 128) kills every WebView ES2 context (getContext('webgl') = null;
# ARM/ATI/IMG replacements all reproduce it — the string is a functional
# dispatch token, not a display string). stealth3 shipped without the
# exception => WebView WebGL dead = the worst fingerprint tell.
#
# Verdicts on fx-2 (ship lib, 2026-10-29 23:51): dumpsys GLES face
# "IMG, AMD Radeon Graphics, OpenGL ES 3.2 V@0615"; chrome WebView WebGL
# unmaskedVendor "IMG" / unmaskedRenderer "AMD Radeon Graphics" (radeonsi/
# chip/ACO/DRM/kernel killed); zero "Mesa" token. Residual (documented):
# "AMD Radeon Graphics" prefix = amdgpu FIRMWARE sku via DRM ioctl
# (kernel-side, not an image file string — cstr patch cannot reach it).
#
# COPY-only, no RUN, no network. Secrets: NONE.

FROM water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2
COPY --chown=0:0 images/gms-mtg-oemprop-stealth3b/patches/libgallium_dri.so /vendor/lib64/dri/libgallium_dri.so
