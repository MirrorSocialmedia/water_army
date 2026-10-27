# water_army T1 GMS variant — microG spoof on stock redroid 14
#
# Base: SAME pin as production (docker/redroid-matrix + images/redroid-w1b):
#   redroid/redroid:14.0.0-240527  (x86_64)
#
# Adds (preinstalled system apps, non-privileged layout):
#   /product/app/microG-GmsCore/com.google.android.gms.apk   (microG GmsCore, Apache-2.0, self-signed)
#   /product/app/microG-Vending/com.android.vending.apk      (microG "Play Store")
#
# Layout decision (documented, PoC-grade):
#   /product/app (NOT priv-app) — a GmsCore/vending priv-app placement requires
#   matching privapp-permissions allowlist XMLs or Android 14 fails to boot on
#   unlisted signature|privileged perms. microG's own supported install path on
#   stock ROMs is a user install, so non-privileged system placement is the
#   conservative PoC layout. Real-device R step verifies self-update + account
#   sync from HERE; if a priv upgrade is needed, that is a PoC finding, not a
#   pre-emptive complication.
#
# RED LINES honoured:
#   * stock pin base ONLY — W1b carrier/ro.* mapping layer NOT touched (two-layer
#     merge is a post-PoC decision; see docs/gms-variants.md)
#   * sha256-pinned inputs (SOURCE-PIN.sha256; no :latest anywhere)
#
# Build (network only; negligible RAM — NOT a redroid boot):
#   ./fetch.sh            # downloads APKs to vendor/, checksum-verified
#   docker build -t water-army/redroid:14.0.0-240527-gms-microg .

# NOTE: stock redroid image has NO usable /bin/sh (RUN impossible in base —
# W1b discovery). COPY-only layering, modes from build context (0644 APKs).

FROM redroid/redroid:14.0.0-240527

COPY vendor/com.google.android.gms-252432034.apk /product/app/microG-GmsCore/com.google.android.gms.apk
COPY vendor/com.android.vending-84022634.apk     /product/app/microG-Vending/com.android.vending.apk
