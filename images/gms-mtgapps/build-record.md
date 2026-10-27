# T1-gms build record — MindTheGApps variant (2026-10-27, CTO code segment)

Docker build only — NO redroid boot (RAM gate closed; boot = real-device leg R1).

| Item | Value |
|---|---|
| Image tag | `water-army/redroid:14.0.0-240527-gms-mtg` |
| Image ID / digest | `sha256:02ab5675ba15f4acadaf21544a9e28aa5af774c3dd6a7e53e8b74d002fa4ecee` |
| Total size | 3.69 GB (base ≈3.2 GB shared + ≈0.49 GB delta) |
| Input | `MindTheGapps-14.0.0-x86_64-20250330.zip`, sha256 `ea6738b4908c1290447f610f365e84d46ca894c9a65eef90b83030d769990d7f` ✓ verified at fetch + at build |
| Input URL | `https://downloads.sourceforge.net/wsa-mtg/x86_64/20250330/MindTheGapps-14.0.0-x86_64-20250330.zip` (GET with `--http1.1 -A Wget/1.21` passes SF WAF; HEAD/REST 403 from this host) |
| Base | `redroid/redroid:14.0.0-240527` (production pin, same as W1b) |
| Payload | 33 files staged: product priv-app GmsCore/Phonesky/Velvet/Wellbeing/GooglePartnerSetup/AndroidAutoStub + app sync-adapters + sysconfig + privapp-permissions XMLs; system_ext priv-app SetupWizard/GoogleServicesFramework/GoogleFeedback + its privapp XML |

## Layout verification (docker export audit)

* Partition symlinks INTACT: `product -> /system/product`, `system_ext -> /system/system_ext`.
* Files land under real dirs: `system/product/priv-app/GmsCore/GmsCore.apk`, `system/system_ext/priv-app/GoogleServicesFramework/…` ✓.

## Build pitfall found & fixed (this session)

`COPY --from=unpack /stage/ /` (dir-root copy) **replaces the base's partition
symlinks with real dirs** → `/product` then shadows the base's 358
`/system/product` files (runtime would see ONLY the 53 copied entries).
Fix: COPY per-subdirectory (`/stage/product/ → /product/`), docker follows the
symlink and merges. Caught by `docker export` prefix-count audit, not by build
exit code. Same pattern applied to gms-opengapps Dockerfile.

Builder drift note: builder stage `alpine:3.20` is a moving tag (same caveat as
W1b gcc stage). Payload reproducibility is anchored by the INPUT zip pin;
builder only runs unzip/cp (no compiled artifacts leave the stage).
