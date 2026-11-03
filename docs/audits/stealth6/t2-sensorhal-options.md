# WA-STEALTH6 T2 — sensors fake HAL 源流調查（只有調查，未實作）

日期: 2026-11-03 · 機 = **rdev-fx2**（stealth5 `2de5d82a`）· 目的 = 為 T2「sensors fake HAL（accel+gyro+proximity 入 sensorservice）」評估兩條路，俾接力段執行。

## 現場源流（全部 on-device 讀值）

|  probe | 結果 | 判讀 |
|---|---|---|
| `dumpsys sensorservice` | `No Sensors on the device`、`devInitCheck : -19` | sensorservice **活緊**，但 HAL 綁定失敗（−19 = ENODEV） |
| `service list \| grep -i sensor` | `android.frameworks.sensorservice.ISensorManager`、`sensor_privacy`、`sensorservice` 三條都在 | framework 端 service 齊（呢啲唔係 HAL） |
| `ls /vendor/lib64/sensors.*.so /system/lib64/sensors.*.so` | **冇**（無 legacy `sensors.*.so` module） | 無 HIDL passthrough 候選 |
| `ls /vendor/lib64/hw /vendor/bin/hw` | hw 目錄淨 `android.hidl.memory@1.0-impl.so`；bin/hw 冇 sensors | 無 AIDL HAL 服務進程 |
| `ls /system/lib64 | grep sensors` | `libsensor.so` / `libsensorprivacy.so` / `liblibsensorservice.so` + `android.hardware.sensors@1.0/2.0/2.1.so`、`sensors-V2-ndk.so` | **客戶端/IDL 庫齊，server 端實作零** |
| `/apex` | 冇 sensors APEX | 唔行 APEX 路 |
| `/vendor/etc/vintf/manifest.xml` | grep sensor 冇中 | **VINTF 未宣稱 sensors HAL**（補 HAL 要一併加 manifest 條目） |
| `/vendor/etc/permissions/handheld_core_hardware.xml` | 有 `android.hardware.sensor.compass` + `android.hardware.sensor.accelerometer`；proximity/light 只係註釋（未宣稱） | feature 層已經「半套」：DevCheck 計分靠 SensorManager 真 list（而家 0 隻 ⇒ −15），feature 字串唔係計分位，但 proximity feature 宜一齊補做一致 |
| 假 ARM cpuinfo（stealth5 已 bake） | `oem_cpu_clusters` carrier 已注入 8 核 ARM 假 cpuinfo | 真機 cpuinfo 有「Sensors:」行呢類 ARM 特徵，呢度唔係計分位，唔使補 |

**根因一句**：redroid 鏡像有 sensors **客戶端**堆（libsensor/sensorservice + IDL stubs），冇 **server 端 HAL** ⇒ sensorservice ENODEV ⇒ `getSensorList()` 空 ⇒ DevCheck「Core sensors present」−15。

## 路 (i)：搵現成 x86_64 sensors HAL

- redroid 家族內 **冇半成品**（上表已掃晒：無 `sensors.*.so`、無 AIDL 服務 binary、無 apex、VINTF 冇宣稱）。
- 外界 candidates（x86_64 userland 直接可用）：
  1. **Cuttlefish / AOSP emulator 鏡像** 嘅 `android.hardware.sensors@2.1-service`（AIDL，NDK backend）：通常綁 evdev/虚拟 sensor，**要 input device 或 mock backend**先有讀值；搬 binary 要連埋 `android.hardware.sensors-V2-ndk.so`（我哋已有）+ service .so 鏈 + VINTF 條目 + rc。**風險**：Cuttlefish HAL 對 evdev/properties 有假設，redroid 容器要湊 `/dev/input/*`。
  2. Android Studio emulator（x86_64）`sensors.ranchu.so`（legacy HIDL/AIDL mixed，綁 qemu 通道）— 依賴 emulator 專有 transport，**搬入嚟成本 > 收益**。
  3. `sensors.mock`（AOSP `hardware/interfaces/sensors/2.1/aidl/default` 內建 mock，AIDL `Sensors` 支援 `sensors.mock` prop 開關）— **最輕嘅「現成」候選**： theoretically 一個 service binary + `sensors_get_hal` 讀 mock；但 mock 嘅 sensor list 係內置固定（未必啱 accel/gyro/prox 三隻 story）。
- **判定**：現成路冇「零改動即用」嘅 x86_64 prebuilt；要嘛搬 mock 試啱唔啱，要嘛落 (ii)。

## 路 (ii)：自製 minimal AIDL HAL（建議）

- **API 子集**（NDK AIDL backend，`android.hardware.sensors.SensorsDevice`）：
  - `getSensorsList` → 返回固定 3 筆（Accelerometer 0x00000001 type=1、GYROSCOPE type=4、PROXIMITY type=8；name/vendor/stringType 照真機字串，resolution/maxReportedLatency 俾 sensible 值）
  - `registerCallback` / `registerStreamingCallback`
  - `setEnable`（activate）/ `setEnableAsync`
  - `batch` / `getSamplingPeriod`（收住就得，返回 accepted）
  - `getSensorInfoBufferCount`、`flush`、`canSensorBatch`、`getSensingConfiguration`（2.1）
  - 讀值源：起步可 **常量 + 微抖動**（accel ≈ (0, 0, 9.81)+noise、gyro ≈ 0、proximity ≈ 5cm far）— 求嘅係「有、喺度 report、唔崩」，唔求動作劇情（動作剧情係 WA-FIXALL T59 battery 級別 follow-up）
- **工作量**：細至中。C++/Rust 都得（我哋有 Rust 底）；AIDL 後端 NDK 版 ~300–500 行骨 + 一個 `service.cpp`/rc；**唔使 kernel、唔使 devicetree**（容器內純 userland）。
- **配套三件**：① VINTF manifest 加 `android.hardware.sensors.ISensors/default`（version 1.0，interface `ISensors` + `SensorsDevice` 視 implementation 版本）；② init.rc service（class hal / user system + `start` 依賴 class main）；③ SELinux 喺 redroid = HACKED 形同虛設（省 policy 工）。
- **風險**：sensorservice 對 HAL 版本协商（2.0 vs 2.1 vs 3.x AIDL `V2SensorManager`）— 鏡像內有 `sensors@2.0/2.1.so + V2-ndk` ⇒ 對 **AIDL 2.1（V2SensorManager）** 有期望嘅機率最高；實作時用 `ISensors` AIDL（`android.hardware.sensors.ISensors`，NDK）同 sensorservice 嘅 `SensorManager` native 端 tie 住。第一步先照 `dumpsys sensorservice` 睇佢點解 ENODEV（`service_manager` 搵唔到 `sensors` service 即 ENODEV）。

## 推薦（俾接力段）

1. **直接行 (ii) 自製 minimal HAL**：源流清楚（現成嘅全要湊環境），自製嘅 API 子集細、可控、宣稱欄全部自己對住真機字串寫。
2. 驗收鏈（前後對帳）：`feature xml`（補 `android.hardware.sensor.proximity` + light 可選）→ `dumpsys sensorservice` 出 3 隻 + `sensorservice` 有 streaming count 活動 → DevCheck「Core sensors present」−15 → 0。
3. 記低：**DevCheck 計分靠 SensorManager runtime list，唔靠 feature 字串**（現場 evidence：feature 已宣稱 accelerometer 都照扣 −15）。

## 現場讀值原件

`/tmp` 場測 dump 已歸檔：`t1-fx2-abi-props-after.txt`（含 sensors 段讀值）；主報告見 `t1-abi-field-test.md`。
