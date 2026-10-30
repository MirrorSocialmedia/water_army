# water_army WA-FIXALL S2 — stealth4 layer (GMS refresh + R42/R43/R52 carriers + display candidate A plumbing).
#
# Base: water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth3b (digest
# sha256:27bd064d…). COPY-only, no RUN, no network (stealth3b discipline).
#
# What lands (see build-record.md for provenance + asserts):
#   1. /system/product/priv-app/GmsCore/GmsCore.apk        — 2026-generation
#      GMS universal APK (26.42.31, versionCode 1005867181) replacing the
#      2022-era MTG build (R51 leak point: ancient check-in version).
#   2. /system/system_ext/priv-app/GoogleServicesFramework/GoogleServicesFramework.apk
#      — matching-generation GSF (compileSdk 14; permission set identical to
#      the in-image one — 109/109).
#   3. /vendor/etc/permissions/privapp-permissions-stealth4.xml — SUPERSET
#      allowlist for the two refreshed packages (gen file: gen-privapp-xml.py).
#   4. /vendor/etc/permissions/android.hardware.telephony.gsm.xml — R42 phone
#      form (framework telephony presence).
#   5. /vendor/etc/init/stealth4-extras.rc — hand-written carrier rows for
#      ro.baseband / ro.radio.noril / net.hostname / debug.sf.* (display
#      candidate A). The GENERATED oem-ro-map.rc chain is untouched (its CI
#      rc-diff test keeps passing).
#
# Secrets: NONE. All values ride boot args per container (template roOverrides),
# never baked props.

FROM water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth3b
COPY --chown=0:0 images/gms-mtg-oemprop-stealth4/vendor/gmscore-264231-uc.apk /system/product/priv-app/GmsCore/GmsCore.apk
COPY --chown=0:0 images/gms-mtg-oemprop-stealth4/vendor/gsf-uc.apk /system/system_ext/priv-app/GoogleServicesFramework/GoogleServicesFramework.apk
COPY --chown=0:0 images/gms-mtg-oemprop-stealth4/files/vendor/etc/permissions/privapp-permissions-stealth4.xml /vendor/etc/permissions/privapp-permissions-stealth4.xml
COPY --chown=0:0 images/gms-mtg-oemprop-stealth4/files/vendor/etc/permissions/android.hardware.telephony.gsm.xml /vendor/etc/permissions/android.hardware.telephony.gsm.xml
COPY --chown=0:0 images/gms-mtg-oemprop-stealth4/files/vendor/etc/init/stealth4-extras.rc /vendor/etc/init/stealth4-extras.rc
