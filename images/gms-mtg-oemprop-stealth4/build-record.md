# WA-FIXALL S2 — stealth4 build record (2026-10-30)

- **Image**: `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth4`
  digest `sha256:8ec65a4d2125e67d11d683736d98cac1102365e0c5db2db7b383923af960d94a`
- **Base**: `14.0.0-240527-gms-mtg-oemprop-stealth3b` @ `sha256:27bd064d1d42` (pin-checked in build.sh)
- **Build**: legacy builder, COPY-only (no RUN, no network), 5 COPY layers;
  `bash images/gms-mtg-oemprop-stealth4/build.sh` fail-closed pins + in-image asserts (all passed).

## Layer contents
1. GmsCore.apk → `/system/product/priv-app/GmsCore/` — 2026-generation GMS
   26.42.31 (vc 1005867181), replaces 2022 MTG build (R51). Universal APK;
   native libs arm64-v8a/armeabi-v7a only → runs under ndk_translation on our
   x86_64 (see vendor/SOURCE-PIN.md ABI note).
2. GoogleServicesFramework.apk → `/system/system_ext/priv-app/…` — Android-14
   line GSF, permission set identical to in-image (109).
3. `privapp-permissions-stealth4.xml` — superset allowlist (375-line generated
   file; GMS +39 net-new permission surface vs in-image grants; extra non-
   privileged entries ignored, missing-entry fatality avoided).
4. `android.hardware.telephony.gsm.xml` — telephony feature present (R42).
5. `stealth4-extras.rc` — hand-written carriers (ro.baseband, ro.radio.noril,
   net.hostname@boot_completed, debug.sf.auto_latch_unsignaled,
   debug.sf.hwc.min_duration = candidate A plumbing). Generated oem-ro-map.rc
   untouched → CI rc-diff test unaffected.

## Source pivot (recorded): APKMirror → APKPure CDN
apkmirror = Cloudflare managed challenge, bot-fail-closed from this host
(5 attempts: curl, headless chromium 140, headless chrome 154; screenshots in
docs/audits/fixall/s2/). cdnpure (APKPure) serves Google-signed originals via
plain CDN; sha256 pinned. x86_64-only APKMirror variants existed but are
unfetchable here; consequence recorded: GMS native libs = arm64 (translator).

## Deliberate omissions (S2 scope)
- Phonesky not refreshed (D4 doesn't route through Play).
- gserv (gservices client_id) requires network check-in — field-test on fx1.
- Display candidates A/B/C: only candidate A is PLUMBED (props via carriers);
  A/B/C trial = runtime boot-arg flips, no rebuild needed.

## Known risks
- ro.radio.noril=no with no rild → telephony may stay "unavailable"; fx1 reads decide (R42).
- 2026 GMS check-in against Android-14 GSF pairing — fx1 `dumpsys` + login flow decide.
- GMS arm64 libs via translator = extra ~process RSS; MemAvailable delta measured on fx1 boot (for S4 fleet rescan math).
