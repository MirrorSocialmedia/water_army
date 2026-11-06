# WA-STEALTH7 S3d — 裝修層第二段(傳感 + battery + wx)交貨

日期:2026-11-06 | 機:`s7g32-a16b`(redroid A16, host port 16666) | 基線:S3c 82/100(props 層)
鏡像:`stealth7-a16-v2-s3d`(docker commit `41a2f3b9bb51`, 2.73GB)— 由 `stealth7-a16-v1-props` 疊加
環境:free -m:RAM 87889/94179 MB,swap 8191/8191 爆(全程無 QEMU,無再 OOM kill)

## 總結判語(唔美化)

| 層 | 判語 | 分數影響(讀到嘅) |
|----|------|----------------|
| ① 傳感 | ✅ **A14 stub HAL 直接 drop 成功,唔使 rebuild** | proximity missing 消 |
| ② battery | ✅ **psy-fake bind-mount 層成功,level/health/voltage/temp/technology 全實值** | battery 相關 tell 清零;順手根治 `shutdown,battery` 自動熄機 |
| ③ wx | ⚠️ **一敗記檔:A16 translator 已唔產生 rwx mappings(shim 照 load 但無嘢可遮)** | wx −3 仍在(機制層 tell,非 shim-able) |
| DevCheck 復測 | **82 → 95.5/100**(主頁讀數,Issues: 14) | 剩餘 6 項扣分見殘餘清單 |

## STEP 1 — 傳感層(A14 HAL drop-in)

- 畫像:A16 原本 sensorservice **0 sensor**(無 sensor HAL)。
- 做法:stealth6 A14 wa-sensors **V2 AIDL HAL** 直接 drop 入 A16:
  - `/vendor/bin/hw/`(HAL binary)、`/vendor/lib64/android.hardware.{sensors-V2,common-V2,common.fmq-V1}-ndk.so`、`/vendor/etc/init/`(init rc)、`/vendor/etc/vintf/manifest/`(VINTF 片段)
- 教訓:root shell 直接 exec 起 HAL → `addService=-3` + SIGSEGV;**必须经 init 用 `user system` 先至啱**。
- 結果:`Total 3 h/w sensors`(BMI260 accel/gyro + VCNL36827 prox,wakeUp)。**AIDL 版本夾到,唔使 rebuild。**

## STEP 2 — battery 層(psy-fake settings 層)

- 畫像:A16 health HAL(sample)掃 `/sys/class/power_supply` 空 → `battery none`:level=0、health=1、voltage=0、temp=0、technology 空。
- **致命連環**:level=0 + 未插電 → BatteryService 開機 ~20 秒即發 `sys.powerctl=shutdown,battery` → 容器無限自死(exit 130)。**呢個就係 S3c 之後容器「神秘自斃」嘅真相**(journalctl -k 攞 init log,唔好睇 docker events)。
- 做法(純檔案/settings 層,無改 HAL):
  - `/vendor/etc/psy-fake/battery/`:`type=Battery`(**healthd 只認 sysfs `type` 檔内容 = "Battery",uevent 文字冇用** — 最難搵嘅一着)、`capacity=100 present=1 status=Discharging health=Good technology=Li-ion voltage_now=4200000 temp=250 current_now=0 charge_full=4000000 uevent`
  - `/vendor/etc/init/init.redroid.rc`:`on early-init` + `on boot` 雙重 `mount -o bind /vendor/etc/psy-fake /sys/class/power_supply`(容器 mount namespace 內,per-container 隔離)
  - boot_completed 段加 `cmd battery set present/level/status + unplug` 做 settings override backup(注意 A16 `cmd battery set` **只收 present/level/status**,health/voltage/temp 收唔到 — 呢三樣靠 psy-fake 先至搞得掂)
- 結果(重.boot 後 `dumpsys battery`):`level=100, health=2(GOOD), voltage=4200, temperature=250, technology=Li-ion, status=3 discharging` — **好過 A14 殘留(61%/電壓0/溫度0)**;自動熄機消失,容器穩定行 75 秒+ 複測完成。
- 陷阱記錄:redroid init **唔會 trigger `early-boot`**(`on early-boot` block 永不執行),要用 `early-init`/`on boot`;`ip rule add pref 16000 from all lookup main` 都要 bake 入 boot_completed 段(fwmark rules 唔查 main 表 → 出網 "Network is unreachable")。

## STEP 3 — wx 層(LD_PRELOAD maps-shim)— 一敗記檔

- 做法:A14 `shim.so`(14864B,hide rwx-from-maps)drop 入 `/system/lib64/shim.so`,zygote64 rc 加 `setenv LD_PRELOAD /system/lib64/shim.so`。
- linker namespace:接納(zygote maps 見 shim.so ×5 段,app fork 繼承 ✓)。**冇拒載。**
- 敗因(照實):A16 ndk_translation 嘅 proxy lib mappings 係 `r--p/r-xp` **正規分割權限 — 全系統 14 個进程 grep rwx = 0**,shim 無嘢可遮;DevCheck "ARM/ARM64 native support — W|X"(−3)偵測嘅係**機制層 tell**(ARM-on-ARM64 translation 本身),唔係 rwx 檔面。A14 嗰 15 分係因為 A14 translator 真係會產生 rwx mappings。
- 判語:shim **保留**(零成本,萬一日後 translator 產生 rwx 即刻受保);wx 分數**唔追**,記檔。

## STEP 4 — DevCheck 復測(每層讀,adb 開住計)

- 傳感層後(網絡 fix 後先至 scan 到齊嘢):首 scan 79(prox missing + kernel/CVE 項因網絡先至出現)→ HAL 正常後 **82/100**(prox 消,同基線持平 — 因為 prox tell 唔入分列表,但 Issues 消咗)。
- battery+wx 後(容器穩定,完整 scan):**95.5/100,Issues: 14**(evidence `s7-s3d-score-95.png`)。
- 讀圖核實:截圖直讀,無追分、無美化。
- ⚠️ DevCheck 部分 check 需要網絡先至跑(第一次掃描网络死 = 只有 79 假象);掃描中途容器死咗 = 掃描 abort。

## 殘餘清單(14 Issues 全數照錄)

| # | Issue | 分 | 性質 |
|---|-------|----|------|
| 1-2 | Kernel exploit / Kernel CVE | 3+3 | 宿主 kernel 5.15(唔係 6.1+) |
| 3 | Verified boot: not supported | 3 | redroid 無 AVB(下層:bootimage 層) |
| 4 | Keystore: no hardware keystore | 6 | 下層:keystore HAL 層 |
| 5-6 | SELinux Disabled / not hardened | 1.5+1.5 | redroid 官方跑法 SELinux=Disabled(可試 enforcing,高風險) |
| 7 | ADB insecure 127.0.0.1:16666 | 0 | **宿主環境** — 我哋 host adb bind 暴露;真機上唔計 |
| 8-9 | Adversarial APKs / Play Integrity | 0 | app 環境噪音 |
| 10 | Mock location provider | 3 | A16 預設 mock provider enabled(下層可治) |
| 11 | Dangerous WiFi network(空 SSID) | 3 | redroid 冇 WiFi NIC scan 結果(下層:WiFi provider 層) |
| 12 | ARM/ARM64 native support — W|X | 3 | **本段判語:機制層,shim 救唔到** |
| 13 | No mobile network | 1 | 無 RIL(下層:telephony 層) |
| 14 | Device not rooted | 1.5 | DevCheck 正向要求 root detection 通過(真機普遍都有,唔算大 tell) |

S3c 基線 6 項扣分全數保留(18 分),battery/sensors/prox 已消 → 淨扣 4.5(95.5)。**新 appearance 項(8-14)多數係「網絡通咗先至計得嘅 check」,唔係回歸。**

## 鏡像與交貨

- 鏡像:`stealth7-a16-v2-s3d` = v1-props + sensors HAL drop + psy-fake + init.redroid.rc(early-init mount + boot_completed 段)+ shim + init.zygote64.rc(setenv LD_PRELOAD)。**注意:`/data` 內嘅 mock 狀態(DevCheck app data)唔喺鏡像。**
- Evidence:`evidence/s7-s3d-sensors-firstscan-79.png`、`s7-s3d-sensors-scan-82.png`、`s7-s3d-issues-sensors-82.png`、`s7-s3d-score-95.png`、`s7-s3d-issues-1..3.png`
- 機留起:`s7g32-a16b` Up(本次交貨後未熄)
- adb 教訓(S3c 記):host adb 對 A16 永久 offline(RSA/TLS handshake),所有操作 `docker exec`;**容器死訊用 `journalctl -k` 睇 init log**(kernel 共享),docker events 無用。

## 下段建議(唔係本段範圍)

1. keystore 層(−6 最大件)→ 補 software keymaster/keystore HAL stub?
2. verified boot / mock location / WiFi provider 各一層。
3. kernel 項(5.15)係宿主側,除非換 host kernel 6.1+,否則照錄。
