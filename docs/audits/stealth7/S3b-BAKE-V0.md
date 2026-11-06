# S3b 鏡像固化 + 早期 DevCheck 讀數（WA-STEALTH7 gen32）

**Date:** 2026-11-06 (GMT+8) · **Task:** mw3q37y8zyzvd (S3 支線)
**目的:** 將 s7s2-a16 overlay upper（berberis/ndk_translation 移植）固化入鏡像，起新機驗證持久性，再讀早期 DevCheck 分數（門前快讀，非正式 T7）。

## 鏡像 sha

| 鏡像 | sha256 |
|---|---|
| `stealth7-a16-v0-bridge` | `198619914bd73aeb1f81b8c28a5b55c64c704477ede804bdaffa3c4d42d770f6` |

來源：`docker commit s7s2-a16 stealth7-a16-v0-bridge`。

## 新機規格

| 項目 | 值 |
|---|---|
| 名稱 | `s7g32-a16b` |
| 鏡像 | stealth7-a16-v0-bridge |
| Port | 127.0.0.1:16666→5555 |
| 模式 | `--privileged`, gpuMode=host, binfmt 註冊 |
| 啟動參數 | 同 s7s2-a16（qemu=1, redroid, memfd, 1080×2400, 420dpi, 60fps） |

## 持久性判語：**通過**

commit 後新容器 `s7g32-a16b` 實測全部存活：

| 項目 | 讀值 | 判定 |
|---|---|---|
| boot_completed | `1` | ✅ 正常 boot |
| native.bridge | `libndk_translation.so` | ✅ 翻譯引擎 prop 持久 |
| fingerprint | `redroid/.../16/BP2A.250605.031.A3/eng.root` | ✅ A16 |
| isa.arm64 | `x86_64` | ✅ |
| abilist64 | `x86_64,arm64-v8a` | ✅ |
| binfmt_misc | `arm64_dyn, arm64_exe` 已註冊 | ✅ rc 生效 |
| bridge libs | `/system/lib64/libndk_translation*` 全套 | ✅ |
| arm64 guest libs | 56 檔 | ✅ |
| DevCheck (已裝) | `com.deviceinsight.ai`（pm list 確認） | ✅ APK persist in image |

**arm64 dlopen 探測（重跑）：**
- logcat EM_AARCH64 count = **0**（S2 基圖：每次 app 起動都有；本機全無）
- nativeloader: `libdatastore_shared_counter.so ... : ok`
- maps：guest arm64 libc.so、proxy_libc.so、ndk_translation 7 處常駐
- 截圖核：1080×2400、2077 unique colors、非黑幀

**判語：commit 後引擎照活，持久性通過。改動無走漏（/data APK + /system libs + /vendor/build.prop 全部帶到）。**

## DevCheck 早期讀數（門前快讀）

| 項目 | 值 |
|---|---|
| Integrity score | **80/100** |
| adb 狀態 | 開住計（教訓照實記 adb -3 → 無 adb ≈ 83） |
| Issues (2) | No verified boot（0/1）、No hardware-backed key store（0/1） |
| Passed (部分可見) | hardware-backed key store（key not hardware）、software keyboard、no screen brightness button、physical brightness/volume buttons |
| 截圖核 | 2077 unique colors、mean=239.5、非黑幀 ✅ |
| 黑幀即拒 | 通過 ✅ |

**注意：呢個只係 Onboarding/主屏早期快讀，唔係正式 T7 逐屏場測。未追分、未為分改嘢。**

## 邊界照實

1. DevCheck 早期分 **80/100**（adb on）— Issues 只睇到 2 條（onboarding 頁底部截圖可能遮蓋更多）。正式 T7 逐屏場測先至有完整分。
2. APK 已入鏡像 `/data/app`（commit 帶埋 `com.deviceinsight.ai`）— 後起跑 new container 唔使再裝。
3. `s7s2-a16`（舊實驗機）已 `docker stop`，未 remove — 俾 CEO 覆核覆。
4. `s7s2-inspect-a16`（Created 狀態殘留）— 未處理，唔影響。
5. Swap 仍然接近爆（8184/8191 MB，僅 7MB free）— 唔准起 QEMU 照舊適用。
6. 禁碰名單 {rdev-f1, mc-dogfood-1, rdev-fx1}：全程零沾 ✅。

## 交付

- 本文檔 + `evidence/s7g32-early-devcheck.png`（早期截圖）+ `evidence/s7g32-bake-evidence.txt`（getprop/logcat/maps 全文）
- 鏡像：`stealth7-a16-v0-bridge`（1986199…d770f6）
- Kairo `mw3q37y8zyzvd` note
- 新機 `s7g32-a16b` @16666 留起俾 CEO

## free -m（收段）

Swap: 8184/8191 (接近爆)、MemAvailable ≈12.3G。禁碰名單全程零沾。
