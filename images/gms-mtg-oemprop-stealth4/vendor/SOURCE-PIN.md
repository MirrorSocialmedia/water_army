# stealth4 vendor APKs — provenance pins (WA-FIXALL S2, fetched 2026-10-30)

| file | package | version | sha256 | size |
|------|---------|---------|--------|------|
| gmscore-264231-uc.apk | com.google.android.gms | 26.42.31 build 100400 (versionCode 1005867181) | 4a0b878b780daa627387efb280013826990816c87469dff5cb2b07e697c03460 | 279,024,356 |
| gsf-uc.apk | com.google.android.gsf | platform GSF (compileSdk 14, Android 14 line; permission set 109 = identical to in-image) | 7a0f9e6400ba74b95f95e2bd11a3197abcc9199fe2781a2d8ccd6a9bd2b9422d | 5,716,267 |

Fetch URLs (CDN direct, no auth, no CF challenge — verified 2026-10-30):

- `https://d.cdnpure.com/b/APK/com.google.android.gms?version=latest`
  → redirects to `data.winudf.com/APK/...filename=Google+Play+services_26.42.31+(100400-1005867181)_APKPure.apk`
- `https://d.cdnpure.com/b/APK/com.google.android.gsf?version=latest`

## Why APKPure CDN and not APKMirror x86_64 variants (s2-plan default)

apkmirror.com sits behind a Cloudflare **managed challenge** on this host and
fails closed for every non-interactive client (curl, headless chromium 140,
headless google-chrome 154 — 5 attempts; see docs/audits/fixall/s2/s2-apkm.mjs
screenshots). APKPure serves Google-signed original APKs from a plain CDN
(cdnpure/winudf), so provenance = Google signing + CDN + sha256 pin.

## ABI note (recorded consequence)

The 2026 GMS universal APK carries `lib/arm64-v8a` + `lib/armeabi-v7a` only
(NO x86_64 native libs — modern Google stopped shipping x86). On our x86_64
redroid the GMS process will therefore run its native components through
`libndk_translation` (native bridge already enabled: ro.enable.native.bridge.exec=1).
This is consistent with the R40 posture (the fleet abilist story already leads
with arm64-v8a). GSF is pure Java (no lib/ entries) — arch-neutral.
The pre-replacement MTG GMS (22.21.16, x86_64 libs, 2022 leak point R51) is
fully superseded.

## Version-code note

The plan's "versionCode > 222116xx" guard refers to check-in version reporting,
not install ordering (these are SYSTEM partition APKs — PackageManager does not
gate system APKs by versionCode). 26.42.31 = 2026-generation check-in version =
the R51 fix vector.
