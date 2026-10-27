# water_army L3-C' ARM-translator variant — houdini (Intel ARM→x86 native
# bridge) + A14 init.rc hack on the gms-mtg image (MindTheGApps A14 x86_64).
#
# Base: water-army/redroid:14.0.0-240527-gms-mtg (id pinned by build.sh:
#   sha256:02ab5675ba15f4acadaf21544a9e28aa5af774c3dd6a7e53e8b74d002fa4ecee)
# Rationale (docs/l3-play-integrity.md 2d'): GMS app-lineage variant is the
# experiment target; w1b carrier layer stays orthogonal (two-layer merge =
# post-PoC decision, same red line as gms-mtgapps).
#
# What this layer adds (inputs pinned in vendor/arm-translator/SOURCE.md):
#   * houdini prebuilts (rote66/vendor_intel_proprietary_houdini@0c149b1,
#     the exact commit redroid-script pins for Android 14; md5 of the zip is
#     redroid-script's own pin d9703a9b...) ->
#       /system/bin/houdini{,64}            binfmt interpreters   (0755)
#       /system/lib{,64}/libhoudini.so      native-bridge libs    (0644)
#       /system/lib/arm/** /system/lib64/arm64/**  translated lib mirrors
#       /system/etc/binfmt_misc/arm{,64}_{exe,dyn} binfmt registration files
#       /system/etc/init/houdini.rc         binfmt registration rc (0644)
#   * redroid_libhoudini_hack@a2194c5 14.0.0/ ->
#       /system/etc/init/hw/init.rc         REPLACED: delta vs stock = 2 exec
#         lines after perform_apex_config that boot-patch the runtime
#         /linkerconfig/ld.config.txt to permit /system/lib{,64}/arm{,64}
#         namespaces (pre-zygote). Verified diff vs base = ONLY those lines.
#       /system/etc/ld_config{,_swcodec}.patch  inputs the init.rc applies
#
# Runtime props (NOT baked — docker run args, see scripts/rdev-single cmdfile):
#   ro.dalvik.vm.native.bridge=libhoudini.so   (base advertises the DEAD
#     libnb.so — this is the fix for that red flag; abilist already carries
#     arm groups in base build.prop = now an HONEST advertisement, 2d' 防偵測)
#   ro.enable.native.bridge.exec[64]=1 (+ ro.vendor.* variants)
#
# finalize discipline honoured (W1b lesson): modes/ownership of the init rc
# files decide whether init imports them at all ("Skipping insecure file").
# build.sh runs POST-BUILD ASSERTIONS on the exported layer tar — COPY-from-
# stage preserves stage modes (stage is root-owned) but trust-but-verify.
#
# Build: ./build.sh   (network only if vendor zips absent; RAM-negligible —
# NOT a redroid boot)

# --- stage 1: unpack + mode pinning (builder = alpine, runs as root) --------
FROM alpine:3.20 AS unpack
RUN apk add --no-cache unzip
COPY vendor/libhoudini-0c149b1.zip /tmp/houdini.zip
COPY vendor/libhoudini-hack-a2194c5.zip /tmp/hack.zip
COPY houdini.rc /tmp/houdini.rc
RUN set -eu; \
    cd /tmp && unzip -q houdini.zip && unzip -q hack.zip; \
    H=/tmp/vendor_intel_proprietary_houdini-0c149b1e14d7bfd4b2af261afc6f2e80517dbd98/prebuilts; \
    K=/tmp/redroid_libhoudini_hack-a2194c5e294cbbfdfe87e51eb9eddb4c3621d8c3/14.0.0; \
    # required-file existence gates (fail closed, mirroring gms-mtgapps pattern)
    test -f "$H/bin/houdini" && test -f "$H/bin/houdini64" \
      && test -f "$H/lib/libhoudini.so" && test -f "$H/lib64/libhoudini.so" \
      && test -d "$H/lib/arm" && test -d "$H/lib64/arm64" \
      && test -f "$H/etc/binfmt_misc/arm_exe" && test -f "$H/etc/binfmt_misc/arm64_dyn" \
      && test -f "$K/etc/init/hw/init.rc" && test -f "$K/etc/ld_config.patch" \
      && test -f "$K/etc/ld_config_swcodec.patch"; \
    # arm mirrored-lib counts sanity (redroid-script flow ships ~650 files)
    test "$(find "$H/lib/arm" -type f | wc -l)" -ge 300; \
    test "$(find "$H/lib64/arm64" -type f | wc -l)" -ge 300; \
    mkdir -p /stage/bin /stage/nb32 /stage/nb64 /stage/arm /stage/arm64 \
             /stage/binfmt /stage/init /stage/inihw /stage/ldpatch; \
    cp "$H/bin/houdini" "$H/bin/houdini64" /stage/bin/; \
    cp "$H/lib/libhoudini.so" /stage/nb32/; \
    cp "$H/lib64/libhoudini.so" /stage/nb64/; \
    cp -a "$H/lib/arm/." /stage/arm/; \
    cp -a "$H/lib64/arm64/." /stage/arm64/; \
    cp "$H"/etc/binfmt_misc/arm* /stage/binfmt/; \
    cp /tmp/houdini.rc /stage/init/houdini.rc; \
    cp "$K/etc/init/hw/init.rc" /stage/inihw/init.rc; \
    cp "$K"/etc/ld_config*.patch /stage/ldpatch/; \
    # mode pin: bins 0755, everything else 0644 (init insecure-file discipline)
    chmod 0755 /stage/bin/*; \
    find /stage -type f ! -path '/stage/bin/*' -exec chmod 0644 {} +; \
    find /stage -type f | wc -l

# --- stage 2: image (COPY-only layering; base has no usable /bin/sh) --------
FROM water-army/redroid:14.0.0-240527-gms-mtg
# per-subdirectory COPYs MERGE into existing base dirs (no root-level
# symlink targets touched — the gms-mtgapps symlink trap does not apply here).
COPY --from=unpack /stage/arm/     /system/lib/arm/
COPY --from=unpack /stage/arm64/   /system/lib64/arm64/
COPY --from=unpack /stage/nb32/    /system/lib/
COPY --from=unpack /stage/nb64/    /system/lib64/
COPY --from=unpack /stage/bin/     /system/bin/
COPY --from=unpack /stage/binfmt/  /system/etc/binfmt_misc/
COPY --from=unpack /stage/init/    /system/etc/init/
COPY --from=unpack /stage/inihw/   /system/etc/init/hw/
COPY --from=unpack /stage/ldpatch/ /system/etc/
