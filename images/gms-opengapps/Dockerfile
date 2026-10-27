# water_army T1 GMS variant — OpenGApps (x86_64) on stock redroid 14
# STATUS: input zip NOT downloadable from this build host (SourceForge WAF,
# see SOURCE.md) — build blocked on manual intake; Dockerfile ready regardless.
#
# Base: SAME pin as production: redroid/redroid:14.0.0-240527 (x86_64)
#
# Input: vendor/open_gapps-x86_64-12.1-pico-20220503.zip
#   — last OpenGApps x86_64 build EVER (2022-05-03; max Android 12.1 — no 14
#   builds exist). SHA-256 to be filled into SOURCE-PIN.sha256 at manual intake.
#
# Integration method: same flat-layout remap as gms-mtgapps IF the zip carries
# `system/**` partition paths (verified assumption for the 2022-era flashable
# format). If the fetched zip instead shows the "superzip" format
# (CoreFeatures.xml + <arch>/*.xz + install scripts), unpack-opengapps.sh must
# be extended to apply the CoreFeatures token→path mapping — flagged
# ⚠ VERIFY-AT-INTAKE; do not trust until the real file is in hand.
#
# Known-role caveat (docs/gms-variants.md): 2022-era GmsCore on an A14 base is
# a CONTROL ARM, not a front-runner. Modern Gmail/WhatsApp minServiceVersion
# expectations likely unsatisfiable, and Play cannot self-update services on an
# uncertified device. Kept for comparison only.
#
# RED LINES honoured: stock pin base ONLY; W1b carrier/ro.* layer untouched.
#
# Build (after manual intake):
#   ./fetch.sh   (or drop zip into vendor/ and checksum)
#   docker build -t water-army/redroid:14.0.0-240527-gms-og .

FROM alpine:3.20 AS unpack
RUN apk add --no-cache unzip
COPY vendor/open_gapps-x86_64-12.1-pico-20220503.zip /tmp/og.zip
# ⚠ VERIFY-AT-INTAKE: flat layout assumption below. unzip -l first; adapt if
# superzip (see header). test -d guards fail the build loudly on layout drift.
RUN cd /tmp && unzip -q og.zip 'system/*' \
 && test -d system/product/priv-app \
 && mkdir -p /stage && cp -a system/. /stage/ \
 && find /stage -type f | wc -l

FROM redroid/redroid:14.0.0-240527
# partition symlinks in base (product -> /system/product): COPY per-subdir to
# merge through the symlink — see gms-mtgapps/Dockerfile for the finding.
COPY --from=unpack /stage/product/    /product/
COPY --from=unpack /stage/system_ext/ /system_ext/
