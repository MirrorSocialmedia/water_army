# stealth5 vendored APK — provenance pins (WA-FIXALL S6, fetched 2026-11-03)

| file | package | version | sha256 | size |
|------|---------|---------|--------|------|
| webview-1560807847-arm64.apk | com.google.android.webview | 156.0.8078.47 | e8d07d54142686ea4452386120961ca32f14c350b9711562c3770cbea577d9ed | 262,075,753 |

Fetch URL (APKPure CDN, same channel as the stealth4 GMS/GSF pins — see
../gms-mtg-oemprop-stealth4/vendor/SOURCE-PIN.md for why not APKMirror):

- `https://d.cdnpure.com/b/APK/com.google.android.webview?version=latest`

ABI note: the APK carries `lib/arm64-v8a` + `lib/armeabi-v7a` ONLY (no x86
libs — modern Google). On our x86_64 redroid with native bridge enabled,
PackageManager picks `arm64-v8a` as primaryCpuAbi → Chromium runs via
libndk_translation → `navigator.platform` reports `Linux armv81` in both
carriers (R41 root fix; the replaced in-image MTG webview 125.0.6422.113 had
primaryCpuAbi=x86 → i686 tell).

In-image package name becomes `com.google.android.webview` (was
`com.android.webview` MTG stub) — WebView provider selection is metadata
based (com.android.webview.chromium.* classes present), so provider binding
is unaffected. Old dex2oat oat/x86_64 artifacts are whiteouted (`.wh.oat`).

Sensitive-data scan: vendor APK + SOURCE-PIN only; no secrets.
