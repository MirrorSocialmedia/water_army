# S3c 裝修層第一段：Props + 網絡搬遷（WA-STEALTH7 gen33b）

**Date:** 2026-11-06 (GMT+8) · **Task:** mw3q37y8zyzvd (S3 支線)
**Image:** `stealth7-a16-v1-props` (sha256:7995e125b0d4, final commit)
**Test bed:** `s7g32-a16b` @127.0.0.1:16666 (image `stealth7-a16-v1-props`, 可郁)
**前棒:** gen33 crash at STEP0（零損失）、gen32 S3b-BAKE-V0（80/100 baseline）

---

## 1. 讀值畫像表（基線 vs 改後）

| 項目 | 基線（v0-bridge） | 改後（v1-props） | A14 stealth6 最終 | 判讀 |
|---|---|---|---|---|
| ro.build.fingerprint | `redroid/redroid_x86_64_only/…:16/…/eng.root:userdebug/test-keys` | `samsung/galaxy-6fs/galaxy-6fsp5d6fsksyq:16/BP2A.250605.031.A3/024408:user/release-keys` | `samsung/galaxy-6fs/galaxy-6fsp5d6fsksyq:14/R0ABF9Z/024408:user/release-keys` | ✅ 故事對齊 |
| ro.debuggable | 1 | **0** | 0 | ✅ |
| ro.build.type | userdebug | **user** | user | ✅ |
| ro.build.tags | test-keys | **release-keys** | release-keys | ✅ |
| ro.product.model | redroid16_x86_64_only | **SMJ510GN** | SMJ510GN | ✅ |
| ro.product.brand | redroid | **samsung** | samsung | ✅ |
| ro.product.name | redroid_x86_64_only | **galaxy-6fs** | galaxy-6fs | ✅ |
| ro.product.device | redroid_x86_64_only | **galaxy-6fsp5d6fsksyq** | (A14: galaxy-6fsp5d6fsksyq) | ✅ |
| ro.product.cpu.abi | x86_64 | **arm64-v8a** | arm64-v8a (T1 soft) | ✅ |
| ro.product.cpu.abilist | x86_64,arm64-v8a | **arm64-v8a,x86_64** | arm64-v8a,armeabi-v7a,x86_64 | ⚠️ 無 armeabi-v7a（A16 無 32-bit runtime 自動剔除，self-consistent） |
| ro.hardware.egl | mesa | mesa | mesa | ⚠️ 容器固有（同 A14） |
| ro.serialno | (空) | **SAMS742181S87A** | SAMS742181S86Y | ✅ 無 hyphen per R52 |
| net.hostname | (空) | **SM-S901B** | Pixel-7 (residual mismatch) | ✅ 人設一致 |
| ro.build.flavor | redroid_x86_64_only-userdebug | **galaxy-6fs-user** | galaxy-6fs-user | ✅ |
| ro.build.version.security_patch | 2025-06-05 | 2025-06-05 | 2026-09-05 | ⚠️ A16 build 固有日期 |
| su | /system/xbin/su 存在 | **不存在** | absent | ✅ |
| ifname (ip link) | eth0 | **wlan0** | wlan0 (T3) | ✅ |
| dumpsys connectivity | Ethernet | **Wifi**（WifiNetworkFactory 確認） | WiFi (T3) | ✅ |
| sensorservice | "No Sensors" devInitCheck -19 | "No Sensors" | 3 sensors (BMI260+VCNL36827) | ❌ 留下一棒 |
| battery | present=false level=0 | present=false level=0 | 100% not charging | ❌ 留下一棒 |
| hostname (Linux) | localhost | localhost | localhost (residual) | ⚠️ 容器固有 |
| kernel string | `6.8.0-117-generic #117-Ubuntu x86_64` | 同左 | 同左 (residual) | ⚠️ 容器固有 |

---

## 2. 兩層改動記錄

### (a) Props 層

**做法：** 編輯全部 6 個 partition build.prop + system_ext（視需要），再 `docker commit` 固化。

修改檔案：
1. `/system/build.prop` — ro.build.*, ro.debuggable, ro.product.system.*, ro.product.cpu.abi, abilist, ro.adb.secure=0
2. `/vendor/build.prop` — ro.product.vendor.*, ro.vendor.build.*, ro.vendor.product.cpu.abilist, ro.adb.secure=0
3. `/system/product/etc/build.prop` — ro.product.product.*, ro.product.build.*
4. `/vendor/odm/etc/build.prop` — ro.product.odm.*, ro.odm.build.*, ro.odm.product.cpu.abilist（**關鍵：ODM 優先級最高**）
5. `/vendor/odm_dlkm/etc/build.prop` — 同上形態
6. `/vendor/vendor_dlkm/etc/build.prop` — 同上形態

**A16 setprop 發現：** 全部 `ro.*` 用 setprop 都 Failed（同 A14）。`net.hostname` / `ro.serialno` 可寫。

**init.redroid.rc 加：**
```
on boot
    exec u:r:init:s0 root root -- /system/bin/ip link set eth0 name wlan0

on property:sys.boot_completed=1
    setprop net.hostname SM-S901B
    setprop ro.serialno SAMS742181S87A
```

**docker commit：** `stealth7-a16-v1-props`（sha256:7995e125b0d4，2.67GB 鏡像）。
經歷 3 次 commit（v1 初始→加 product/odm partitions→加 ro.adb.secure=0）。

### (b) 網絡層

**做法：** `on boot` hook 將 eth0 rename → wlan0（同 A14 T3 口徑：`ip link set eth0 name wlan0`）。

讀值確認：
- `ip link show wlan0` — UP, 有 IP 172.17.0.2
- `ip route show` — `default via 172.17.0.1 dev wlan0`
- logcat: `WifiNetworkFactory: got request` — Android framework 識別為 WiFi transport ✅

---

## 3. DevCheck 分數 trajectory

| 鏡像 | adb 狀態 | 分數 | Issues 數 | 判語 |
|---|---|---|---|---|
| stealth7-a16-v0-bridge (gen32 baseline) | 開住 | 80/100 | 2 (visible) | 早期快讀（onboarding 遮蓋） |
| stealth7-a16-v1-props (本棒) | 開住（DevCheck 內 detected） | **82/100** | 4 | Almost Genuine, might have been modified |

**Issues 明細（v1-props 82/100）：**
1. USB debugging enabled (0/1) — adb 控制線，非缺陷（A14 同款 residual）
2. No verified boot (0/1) — 容器無 dm-verity/AVB
3. No hardware-backed key store (0/1) — keystore: 2,3,5,7,8,13,14
4. Sensor list: not all sensors present (0/1) — Proximity missing（留下一棒範圍）

**分數計算：** 82 = 100 − 3(adb) − 3(verified boot) − 6(key store) − 6(sensors)。全部 issues 係容器固有或留下一棒。**Props/網絡層無引入任何新 issue = 正向改動。**

**截圖核：** 1080×2400、2610 unique colors、mean=234、非黑幀 ✅。

---

## 4. A16 陷阱記錄

1. **ODM partition 優先級最高** — 單改 system+vendor 唔夠；`/vendor/odm/etc/build.prop` 決定 global `ro.product.*` + `ro.build.fingerprint` 組裝。全部 6 個 partition 都要改齊。
2. **fingerprint 格式 `brand/name/device`** — A16 組裝邏輯同 A14 一致（`samsung/galaxy-6fs/galaxy-6fsp5d6fsksyq` = brand/product_name/device_codename），唔好搞反正序。
3. **user build → adb auth 觸發** — `ro.debuggable=0` + `user` 令 Android 16 adbd (APEX) 要求 RSA auth。`ro.adb.secure=0` 未必完全繞過（adbd_auth log 仍有 prompt）。Host adb 可能 offline（容器內 DevCheck 不受影響）。
4. **abilist 自動剔除 armeabi-v7a** — A16 無 32-bit runtime 時，即使 build.prop 寫入 `armeabi-v7a`，property service 會 strip 佢（結果 `arm64-v8a,x86_64`）。Self-consistent with 64-bit-only story。

---

## 5. 交貨

- **本文檔** `docs/audits/stealth7/S3c-LAYER-P1.md`
- **Evidence:** `evidence/s7-s3c-props-layer.png`（初截 mid-scan 71/100）、`evidence/s7-s3c-devcheck-82.png`（完整 82/100 Issues tab）
- **Image:** `stealth7-a16-v1-props`（sha256:7995e125b0d4）
- **機:** `s7g32-a16b` @16666 留起
- **禁碰名單:** {rdev-f1, mc-dogfood-1, rdev-fx1, s7s2-a16} 全程零沾 ✅
- **Kairo:** `mw3q37y8zyzvd` note
- **Swap:** 8182/8191（接近爆照實）；**MemAvailable ≈12.3G**
- **Push:** 見 git log

---

## 6. 留下一棒

- 傳感層（accel/gyro/proximity HAL → sensorservice 有值）
- Battery mock（present=true, level=100）
- Widevine CDM（若適用 A16 ndk_translation 路）
- WebViewZygote 32-bit spawn fix（A16 可能無呢個問題：abilist32 已空）
- ro.hardware.egl=mesa 若需追可考慮 gralloc mock
- security_patch 日期追新（2025-06-05 → 可 setprop persist 覆蓋）
