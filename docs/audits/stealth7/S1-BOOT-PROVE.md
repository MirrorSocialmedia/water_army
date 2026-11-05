# S1 boot-prove — Digitalis 同脈 A16 x86_64 鏡像 × 宿主 QEMU/emulator（WA-STEALTH7 gen29）

**Date:** 2026-11-06 (GMT+8) · **Task:** mw3q37y8zyzvd / subtask `mw3q37y8dh3rq`
**Verdict:** ❌ **未prove到 — boot 到唔到 `sys.boot_completed=1`（6 種 launch combo 全死喺 graphics HAL 層）**。翻譯層（ITF v7）因此**未及驗證**（APK 裝唔入 = adbd 未可用）；但宿主前提全綠（見下），失敗根因 = **emulator 36.6.11 系列 × A16 r07 鏡像嘅 gfxstream/HWC 兼容性**，唔係我哋宿主內核/KVM/binfmt 問題。

## 宿主前提核（全部 PASS）

| 項 | 實測 |
|---|---|
| KVM | `/dev/kvm` 存在；`emulator-check accel` → 「KVM (version 12) is installed and usable」 |
| binfmt_misc | `/proc/sys/fs/binfmt_misc/status` = `enabled` |
| RAM 閘（起機前） | MemAvailable 10.0–10.7 GiB ≥ 6144+2560 MiB → PASS（`evidence/s7-free-preboot.txt`、`s7-free-final.txt`） |
| qemu | 宿主自備 `/usr/bin/qemu-system-x86_64` + emulator standalone qemu 兩路 |

## 鏡像（預編譯快路，dev 授權；零 source build）

- **Digitalis 自身無 prebuilt system image release**（GitHub org `DigitalisX64` 全部 6 repo `releases` 實測空；佢哋只有 Berberis translator 嘅 Docker prebuilt，見 t8）。
- 揀**同脈 berberis 系**：Google **Google APIs x86_64「Android 16」emulator image**（entry repo README 親口確認呢啲 image 帶 berberis 血統 arm64 bridge：`libndk_translation.so` 符號表含 `berberis::intrinsics::Arm64ReadFpcr`）。
- 檔案：`system-images;android-36;google_apis;x86_64` rev **r07**（`x86_64-36_r07.zip`，1,895,447,397 B，**sha1 核對相符** `c6bf44bdcd885bb902b4ba752d111a073ad7a817`）→ 落 `/home/kenneth/images/x86_64-36_r07/`（零入 repo）。
- fingerprint（鏡像實證，A16 userdebug）：`google/sdk_gphone64_x86_64/emu64xa:16/BE2A.250530.026.F3/13894323:userdebug/dev-keys`（build_sdk=36）。

## Emulator（預編譯 standalone，兩個 build 都試過）

- `emulator_linux_x64-16783918.zip` 與 `-16551869.zip`（repository2-3.xml revision 皆 **36.6.11**）→ `/home/kenneth/images/emulator-sdk*/`。
- 最小 AVD `s1a16`（config.ini 指 `image.sysdir.1=…/x86_64-36_r07/x86_64/`）。

## 6 種 launch combo 逐 round 照實

| # | emulator | 參數變體 | 死法（錯誤原文撮錄） |
|---|---|---|---|
| 1 | 16783918 | `-gpu swift_indirect` | `INVALID_ARGUMENT: … Minigbm feature is required by this emulator, but is not enabled by the system image or host advancedFeatures.ini`（後手動加 `Minigbm = on` 入 image `advancedFeatures.ini` 解） |
| 2 | 16783918 | `-gpu off` / `-gpu guest` | `FATAL goldfish_address_space.cc:42 GoldfishAddressSpaceDevice::Write unimplemented (offset=0x8, value=0x1000)`（guest kernel goldfish-address-space 驅動 probe 即殺 host qemu；-gpu 無関） |
| 3 | 16551869 | `-gpu swift_indirect -data <dir>` | `qemu-img failed … 'file' driver requires … to be a regular file`（舊版要 `-datadir`；文法問題非 boot 問題） |
| 4 | 16551869 | `-gpu off -show-kernel` | guest 起機至 system_server，但 `vendor.hwcomposer-3 … received signal 6`（SIGABRT，boot+7s）→ `Service 'surfaceflinger' received signal 9` 每 5 秒 crash loop；`exited 4 times before boot completed` |
| 5 | 16551869 | `-gpu guest -show-kernel` | 同 #4 形態：`hwcomposer-3` 死 → `surfaceflinger … signal 9` 每 5 秒 loop，~6 分鐘無 boot_completed |
| 6 | 16551869 | `-cpu host -gpu swift_indirect -show-kernel` | **最健康**：無 init FATAL；SF 活但每 ~10 秒 `Created/Destroyed VkInstance for 'surfaceflinger'`（新 pid 遞增 = SF watchdog 重啟 loop）；adbd 握手一次（adb 見 `127.0.0.1:5555 offline`）；9 分鐘窗口 `sys.boot_completed` 恆空 |

**共同點：** kernel boot 成功（`Kernel command line:` 可見）、zygote/servicemanager 起得来、`init` 正常 — 死因全部集中喺 **graphics HAL（hwcomposer-3 / SurfaceFlinger 同 gfxstream/rutabaga host 端） compatibility**，同 S0 錨點（Digitalis 源碼）無關。

## 翻譯層驗證（未完成，料已備）

- arm64-only APK 已整好：`/tmp/devcheckai-arm64only.apk`（devcheckai.apk 拆 x86_64+armeabi-v7a libs、去 signing block，`abis={arm64-v8a}`，6.79 MB）— 等 boot_completed 先裝到。
- 因 boot 未Completed，`primaryCpuAbi=arm64-v8a` + 「ITF v7 喺宿主內核真活」呢步**未執行到**，唔好當已驗證。

## 教訓（入 memory）

- emulator 36.6.x 同 A16 r07 image 嘅 goldfish-address-space / minigbm / hwc SIGABRT 係**版本配對炸彈**；36.6.11 係最新未必啱 A16（Google XML 只聲明 min-emu 35.4.9，冇設上限＝實測唔可靠）。
- `advancedFeatures.ini` 加 `Minigbm = on` 係 host-side 正解（唔使改鏡像 sha 以外嘅嘢）。
- `-data` vs `-datadir`：emulator 新舊版語義不同（新版 `-data` 可指 dir；舊版要 `-datadir`）。
- `~/.emulator_console_auth_token` 空文件 = console 免登（否则 nc 5554 要 auth token）。
- 對「emulator 快路」時限 1 段嘅紀律：boot 唔起即停（3 連敗規則用足，實食 6 round），**照實報「唔得＋ Graphics HAL 層 compatibility」**，唔好當「宿主內核唔支援翻譯」嘅證據。

## Repro（交接下家）

```bash
export ANDROID_SDK_ROOT=/home/kenneth/images ANDROID_AVD_HOME=/home/kenneth/images/avd
cd /home/kenneth/images/emulator-sdk-1655/emulator
./emulator -avd s1a16 -no-window -no-audio -no-boot-anim -no-snapshot \
  -cpu host -gpu swift_indirect -show-kernel -accel kvm -cores 4 -memory 6144 \
  -datadir /home/kenneth/images/em-data
```

候選下一步（俾 CEO 揀，本棒未執行）：
1. **更舊 emulator（36.4/36.5 era：`emulator_linux_x64-16373346` / `-16173978`）× 36_r07** — 年代配對最正。
2. **36-ext18/ext19 r01 新 image × 現 emulator 36.6.11** — 新 image 配新 emulator（各 1.89 GB，代理落載 ~1 分鐘）。
3. Digitalis Docker 分發（T8 已核內容）行 redroid/容器路，跳過 QEMU graphics HAL。
