# stealth3b build record (WA-FIX2B R2b)

- 日期:2026-10-29(build.sh 全綠:pin + determinism + in-image asserts)
- Base:`water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2` @ `sha256:6e31ac98…`;base libgallium sha256 `0f32f9e8…`
- Patched layer:`images/gms-mtg-oemprop-stealth3b/patches/libgallium_dri.so` sha256 `fc849e97d7d8fb61c573ece680e9db7c2827c8ce10c0026a151e216f005ee411`(35,444,760 bytes,size 零變化)
- Ops:renderer suffix → "%s";GL_VERSION fmt → "… V@0615";'AMD\0' standalone 130 個中 **129 個 → "IMG"**,**gate token @1917602 保留 "AMD"**(renaming 佢 = WebView ES2 死亡;fx-2 實測 bisect r1–r8,ARM/ATI/IMG 全重現)
- Image:`water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth3b` @ `27bd064d1d42`;COPY-only,無 RUN、無 network、零 secret
- In-image asserts:`(radeonsi, `=0、`Mesa 24.0.8 (git-441f064c1c)`=0、`%s%u.%u%s V@0615`=1、standalone `AMD`=1(gate)、standalone `IMG`=160(base 31 + 129 rename)、gate bytes @1917602 = "AMD\0"
- 真機判語(fx-2 同 bytes 熱換實測,r4-retest.md §1/§2):`GLES: IMG, AMD Radeon Graphics, OpenGL ES 3.2 V@0615` + WebGL unmaskedVendor "IMG"/unmaskedRenderer "AMD Radeon Graphics" + WebGL 存活
- **stealth3(ARM 全 rename)作廢**:WebGL 死,唔好再開 stealth3 機;template 改指 stealth3b
