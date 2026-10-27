# gms-mtg-arm build record — L3-C' ARM translator layer (2026-10-27, CTO code segment)

Docker build only — NO redroid boot (boot = real-device leg, RAM-gated).

| Item | Value |
|---|---|
| Image tag | `water-army/redroid:14.0.0-240527-gms-mtg-arm` |
| Image ID | `sha256:5c24b8b678b2338ad9e18e1f4841d03c39088a08b69bd14613659d50eec4a8b8` |
| Base | `water-army/redroid:14.0.0-240527-gms-mtg` (id `02ab5675ba15…`, pinned+asserted by build.sh) |
| Input 1 | `vendor/arm-translator/libhoudini-0c149b1.zip` sha256 `41dd445b4895…78706e` (md5 `d9703a9b…` = redroid-script A14 pin) ✓ fetch-time + build-time verified |
| Input 2 | `vendor/arm-translator/libhoudini-hack-a2194c5.zip` sha256 `5c904d6db5e1…76983` (md5 `8f71a58f…` = redroid-script pin) ✓ |
| Payload | 673-file houdini package staged: bin/houdini{,64} 0755; lib{,64}/libhoudini.so 0644; lib/arm ×318 + lib64/arm64 ×325 mirrored libs 0644; binfmt_misc ×4; houdini.rc; init.rc replacement; ld_config{,_swcodec}.patch |
| Post-build assertion | GREEN — 12 pinned files exact (mode,uid,gid); arm mirrors all 0644 root:root (W1b insecure-file discipline) |

## Key base-image facts that shaped the design (verified 2026-10-27 from `redroid/redroid:14.0.0-240527` build.prop)

* `ro.zygote=zygote64_32` → ARM32 apps have a 32-bit zygote path (boss's Chrome
  is armeabi-v7a — this was the make-or-break precondition; it is satisfied).
* abilist ALREADY advertises `arm64-v8a,armeabi-v7a,armeabi` (+x86) while
  `ro.dalvik.vm.native.bridge=libnb.so` points at a NON-EXISTENT library
  (redroid-doc #933 class of bug) — the "abilist 自相矛盾" red flag. With this
  layer the advertisement becomes honest; the only prop we must flip at boot
  is `ro.dalvik.vm.native.bridge=libhoudini.so` (+ binfmt exec flags).
* `/system/bin/patch` exists (toybox symlink) — the hack init.rc's boot-time
  ld.config patch depends on it; runtime confirmation in EXP-6 evidence.

## Runtime boot args (see `scripts/rdev-single/cmd-mtg-arm.txt`)

```
ro.dalvik.vm.native.bridge=libhoudini.so
ro.enable.native.bridge.exec=1
ro.enable.native.bridge.exec64=1
ro.vendor.enable.native.bridge.exec=1
ro.vendor.enable.native.bridge.exec64=1
ro.dalvik.vm.isa.arm=x86
ro.dalvik.vm.isa.arm64=x86_64
```

(abilist props intentionally NOT overridden — base values already match the
gonwan.com template and are now truthful given a real translator.)
