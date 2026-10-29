# WA-VMSTEALTH S1 — 虛擬機特徵隱蔽機制研究（GL_RENDERER / 傳感器 / 電池 / ro.hardware / MAC）

日期：2026-10-29（gen1）
狀態：研究完結，路線已選定（各節「裁決」+ §6 匯總）。本檔 = 改 image/產品層前的落檔（工單 S1 AC）。
環境口徑：stack 停 + RAM 3GiB → 本單零真機 boot；所有「偽裝生效」宣稱併 WA-ADVERSARIAL-FINAL。

---

## 0. 證據來源（本單實際取得，非推測）

| 來源 | 內容 |
|---|---|
| image 靜態取證（`docker export` gms-mtg-oemprop，無 boot） | HAL inventory、EGL 庫清單、gpu_config.sh 全文、build.prop、health HAL strings、ANGLE/mesa/lvp strings |
| `docs/audits/oemprop-s3/s3-07b-rdfp01-getprop-v4.txt`（592 行真機 getprop dump，profile 綁定機） | 運行時 ro.boot.* / 洩漏 props / battery tracing 實錄 |
| `docs/audits/oemprop-report.md` | ro.hardware 真機生效 + v1 bootloop 教訓 + hwcomposer fallback 先例 |
| 產品代碼 `apps/api/src/services/redroid-service.js` | gpuMode ∈ {swiftshader_indirect, host}（L75）、HostConfig 無 MAC、gpu host → nvidia DeviceRequests（L2299-2303） |

**現狀修正（對工單假設）**：工單寫「ro.hardware 留 redroid 保 HAL」— 已過時。WA-OEMPROP v4（真機 12/12）已將 `ro.hardware` + `ro.boot.hardware` 改寫成 profile board slug（實錄：s3-07b `[ro.boot.hardware]: [redmi-1ba]`）。v1 bootloop 根因已用 `hwcomposer.default.so` fallback 修復。本單第 4 項因此轉為「補其餘 redroid 字串洩漏 + 載體痕跡清理」。

---

## 1. GL_RENDERER

### 1.1 現狀（實證）
- 產品層只有兩個 gpuMode（`redroid-service.js:75`）；生產模板用 `host`（nvidia DeviceRequests）或默認 `swiftshader_indirect`。
- image 內 GPU 機制 = `vendor/etc/init/redroid.common.rc` 喺 early-init exec `gpu_config.sh`：
  - `host` → `ro.hardware.egl=mesa` + `ro.hardware.gralloc=gbm` + 探 DRI render node → `ro.hardware.vulkan=<radeon|intel|…>`；
  - `guest` → `ro.hardware.egl=angle`（鏡像有 `libEGL_angle.so`，無 `libEGL_swiftshader.so`）+ `ro.hardware.vulkan=pastel`；
  - **`swiftshader_indirect`（生產默認值）落唔到任何 case → 三個 prop 全部唔設**（腳本 `unknown mode` 分支）— 默認模式嘅 EGL 選擇靠 libEGL fallback。真機 s3-07b 實錄（gpuMode=host）：`ro.hardware.egl=mesa`、`ro.hardware.vulkan=radeon`。
- **鏡像完全冇 SwiftShader**（export 清單 grep = 0 檔）。軟件渲染 = mesa（llvmpipe）或 ANGLE over mesa Vulkan；vulkan 軟件驅動 = `vulkan.lvp.so`（lavapipe）。
- 洩漏字串（strings 實錄）：
  - `vulkan.lvp.so`：deviceName `llvmpipe (git-53e769e0f1)`（另有 `llvmpipe`）
  - `libGLESv2_angle.so`：組合模板 `ANGLE (` + vendor `Google Inc.`
  - host 模式（本宿主 RTX 3090）：GL_RENDERER 直出宿主桌面卡名（`NVIDIA GeForce RTX 3090/PCIe/SSE2` 類），同宣稱 Adreno/Mali 唔夾。

### 1.2 檢測面
- App 讀法：`GLES20.glGetString(GL_RENDERER/GL_VENDOR/GL_VERSION)`（Java + native 兩路）；`dumpsys SurfaceFlinger`（GLES 行）；Chrome `chrome://gpu`（同 WebView 同源）。
- 公開文獻一致將 renderer 字串列為核心檢測面：真機報 "Adreno (TM) 750"/"Mali-G720"，虛擬機報 SwiftShader/ANGLE/Mesa/"Android Emulator OpenGL ES Translator"（deepidsdk.com emulator-detection-guide；tajapps.com 2026；ptkd.com android-emulator-detection）。反作弊 SDK 普遍查 GL_RENDERER/GL_VENDOR 黑名單；性能特徵（幀時分佈）作 secondary check（deepidsdk 明言 spoof 後 performance profile 仍然露 — 本單唔解決渲染性能面）。

### 1.3 路徑評估
| 路徑 | 內容 | 成本 | 風險 |
|---|---|---|---|
| (a) image 層字串 patch | binary 原地覆蓋：`vulkan.lvp.so` deviceName `llvmpipe (git-53e769e0f1)` → 手機 GPU 名（只准縮短/等長 + NUL 補齊，C 字串語義）；`libGLESv2_mesa.so`/`libEGL_mesa.so` 露點同理。patcher 以**精確字面量 search**（非 offset）定位、找不到 = fail-closed build 失敗 | 低 | 低 — 字串表原地改、無結構/長度變動；最壞 = 名冇改到，唔會 bootloop（EGL 加載唔理字串內容）。ANGLE `ANGLE (`/`Vulkan` 模板字串有指針引用+多处出現，本輪唔動 |
| (b) NDK shim `libGLESv2_stealth.so` | 包真 driver、攔截 glGetString 全量（renderer/vendor/version/extensions 可完全定製，每身份可變） | 高（新二進制 + vendor linker namespace + 全符號 passthrough） | 中 — 未 boot 驗證下引入新 GL 加載路徑 = boot 風險類（違反本單「一輪一變量」紀律）；留 WA-VMSTEALTH-2 |
| (c) LSPosed hook `glGetString` | 覆蓋 Java 路徑 | 高（要 Magisk/Zygisk 棧，紅線外） | 本單範圍外 |
| (d) host GPU 桌面卡名照用 | 零成本 | — | 露宿主型號 + 同 Adreno 宣稱矛盾；RTX 3090 = 全機房同一字串（聚类信號）|

### 1.4 裁決
**(a) 先行**：本輪 image 層 patch `vulkan.lvp.so` deviceName（+ vendor 露點如有）為固定手機級 GPU 名（Adreno 樣板；每身份多樣性留 (b) shim 輪）。產品層規則：**stealth profile 設備應配 guest 路徑 gpuMode**（host 模式桌面卡名照露 — 寫入 release-status NOT VERIFIED 説明）。真機 GL_RENDERER 實字串（dumpsys SurfaceFlinger + chrome://gpu）併 FINAL 取證。

---

## 2. 傳感器（sensors）

### 2.1 現狀（實證）
- **鏡像冇任何 sensor HAL**：`vendor/bin/hw/` 全清單 = audio/bluetooth.sim/cas/gatekeeper/allocator/composer/health/keymaster/omx/power/thermal.mock/rild — 無 sensors 服務、`vendor/etc/vintf/manifest/` 無 sensors XML。框架側 `sensorservice`（system/bin）+ `android.hardware.sensors-V2-ndk.so`（vendor+system）齊 — 即 service 起咗但冇 HAL provider。
- 預期運行時表現：`SensorManager.getSensorList(TYPE_ALL)` = 空/僅虛假 composite；`dumpsys sensorservice` 0 sensors（真機 FINAL 取證）。

### 2.2 檢測面
- 「傳感器缺失或數據唔真實」係 emulator 检测四大類之一（ptkd：missing or faked telephony **and sensors**；deepidsdk：accelerometer/gyroscope absent；ByteHide：sensor availability checks）。FB/GG 系 SDK 都讀 sensor 列表做 device sanity + 反自動化（真人機必有 accelerometer，多數有 gyro/proximity/light）。
- 「有列表但零事件流」同樣露：真人機加速度計有微幅噪點；靜止真機 ax²+ay²+az² ≈ 9.81±0.05 m/s² 且有抖動。

### 2.3 路徑評估
| 路徑 | 內容 | 成本 | 風險 |
|---|---|---|---|
| (a) 自製 AIDL Sensors HAL（NDK 編譯 `android.hardware.sensors-V2-ndk.so` 後端 + 4-6 個常見 sensor + 微幅噪點事件流） | 新 binary + rc + VINTF manifest 條目 + SELinux 域 | 中-高 | **本單紅線級**：VINTF 聲報新 HAL（framework compatibility check）+ 新 SELinux label（precompiled_sepolicy 冇新域 → enforcing 下 init 起唔到 service）— 兩樣都係 boot 面風險，冇 boot 測試下唔應該入 production tag。redroid enforcing 狀態本單未能實證（鏡像有 precompiled_sepolicy；FINAL 首步 `getenforce` 取證） |
| (b) LSPosed hook SensorManager | 同 GL (c) | 高 | 範圍外 |
| (c) 本輪唔動，列 WA-VMSTEALTH-2 | S1 已將 (a) 規格定案（NDK r26 + AIDL backend + `sensors@aidl-default` 移植 + permissive 環境先行驗證） | — | 零 |

### 2.4 裁決
**(c)**：傳感器係五項入面唯一「冇低風險代碼化路徑」嘅 — HAL/VINTF/sepolicy 三樣都係 boot 面改動，違反本單「零 boot 驗證唔入 production tag」紀律（OEMPROP v1→v4 教訓：一輪一個 boot 變量先可以 triage）。代碼化預備（HAL 源 + 規格）留 WA-VMSTEALTH-2；本單交付 = 本節規格 + FINAL 將「sensor 列表空」列為已知殘留檢測面。

---

## 3. 電池

### 3.1 現狀（實證）
- health HAL = `android.hardware.health-service.example`（AIDL 參考實作，讀 `/sys/class/power_supply/*/{capacity,status,voltage_now,…}`；strings 實錄 `No battery devices found` fallback 路徑）。容器 sysfs = 宿主（本宿主 `/sys/class/power_supply/` 空）→ 預期機內「冇電池」框架默認：AC 恆供電、level 100。
- 真機 s3-07b 實錄（洩漏面）：`debug.tracing.battery_status=[1]`（charging）、`battery_stats.plugged=[1]`、`charging=[1]` — 恆「插電 + 100%」形態。

### 3.2 檢測面
- App 讀法：`BatteryManager.EXTRA_LEVEL` / `registerReceiver(BATTERY_CHANGED)` / `BatteryManager.getChargeTimeRemaining()`；`dumpsys battery`（shell only）。
- 檢測文獻列「battery characteristics」（ByteHide）：恆 100% + 恆 AC + 無 temperature/voltage 波動 = emulator 信號；真機放電曲線 + 温度 28-38°C 隨機漂移。

### 3.3 路徑評估
| 路徑 | 內容 | 成本 | 風險 |
|---|---|---|---|
| (a) 產品層 `dumpsys battery set level/status/ac unplug` override（容器 create 後經既有 ADB loopback 通道注入，之後週期性微調 level） | BatteryService override 層 — app 讀到嘅 BatteryManager 數值全部被蓋 | 低（產品代碼，image 零改動） | 低：override 唔經 boot、唔經 SELinux；`dumpsys battery` 輸出會見 `Overrides:` 行（shell/root 先見到，app 讀 API 唔受影响）。重啟後 override 消失 → 產品層 idempotent 重放 |
| (b) image 層 fake sysfs（init rc + tmpfs bind mount 到 /sys/class/power_supply/battery + 更新腳本） | health HAL 食假 sysfs → 全鏈（BatteryStats/dumpsys/Settings）一致 | 中 | **boot 面**：bind mount 標籤/health 域讀 shell_data_file 嘅 sepolicy 判定未知（enforcing 下可能 EACCES）→ 併 VMSTEALTH-2（same class as sensors） |
| (c) Settings.Global 直寫 | BatteryManager 唔食 Settings — 唔解決 | — | — |

### 3.4 裁決
**(a) 本輪實作**（產品層 override：level 隨機 45-92%、status=discharging、temperature 微抖，週期更新）+ **(b) 規格留 VMSTEALTH-2**（全鏈一致版）。真機 FINAL 驗：BatteryManager 讀到 override 值 + level 隨時間變化。

---

## 4. ro.hardware 洩漏（修正後範圍：殘餘 redroid 字串 + 載體痕跡）

### 4.1 現狀（實證）
- `ro.hardware`/`ro.boot.hardware`：oemprop v4 已改寫 = profile slug（真機 `[ro.boot.hardware]: [redmi-1ba]`）。HAL variant 安全性已坐實：`gpu_config.sh` 明確 setprop `ro.hardware.{egl,gralloc,vulkan}`（模塊查找第一優先級 = `ro.<module>.<variant>` property，蓋過 ro.hardware fallback）；hwcomposer 用 `.default.so` 複製修復（v1 bootloop → v2+ boot OK，即真機證據 = 鏡像入面經 ro.hardware 查找嘅 legacy HAL 只有 hwcomposer，已覆蓋）。
- **殘餘 redroid 字串（真機 s3-07b 實錄，任何 app `SystemProperties.get` 可讀 — 全部 default_prop 級別）**：
  1. `ro.build.flavor=redroid_x86_64-userdebug`、`ro.build.product=redroid_x86_64`、`ro.build.description=redroid_x86_64-userdebug 14 … eng.frank.20240527.141332 test-keys`
  2. 全部分區限定變體：`ro.product.{system,vendor,odm,product}.{brand,device,manufacturer,model,name}=redroid*`、`ro.{vendor,odm,system,product}.build.fingerprint=redroid/…test-keys`（檢測 SDK 實際讀分區變體 — Build.MODEL 之外嘅交叉核對路徑）
  3. `ro.boot.redroid_{width,height,dpi,fps,gpu_mode}`（「redroid」字面品牌名）
  4. `ro.boot.oem_*` 載體生值（11 項，`oem_ro_product_model` 等 — 非常規 prop 命名本身即痕跡）
  5. `ro.product.board`/`ro.board.platform` 空值（真機必有 SoC platform token）
- 檢測面：ro.hardware/ro.kernel.qemu/build.* 係 anti-emulation 第一文獻級常規（medium anti-emulation part I：ro.hardware, ro.product.name…；ByteHide：generic device names）— 以上 1/2/3 全部同一檢測面。

### 4.2 路徑評估
| 路徑 | 內容 | 成本 | 風險 |
|---|---|---|---|
| (a) 擴展載體映射：派生欄（flavor/description/build.product/分區變體/fingerprints/board platform）由**已存 profile 欄位確定性派生**，經現有 buildRoCmdArgs→oem_*→rc 鏈注入（`profileToRoOverrides()` 加派生項，**唔動 PROFILE_PROP_MAP 存儲欄** → drift guard 零觸碰；rc 重新生成 = 現有 generator 自動覆蓋）| 低（全有先例：ADR-031 加 hardware 欄即同一改法） | 低：early-init 寫 ro.*（真機驗證路徑）；新 target 全係 ro.* 無 persist |
| (b) 載體自清理：rc 每個 action 寫完 target 後 `oem-propctl --delete` 自己個 carrier（resetprop-rs 支持 delete；消費已喺同一 action 完成 = 自洽） | 低（generator 模板改一行 + 測試） | 低：delete 失敗 = no-op（prop 冇咗先至係目的，留低即現狀） |
| (c) `ro.boot.redroid_*` 刪除 | 同上 delete | **中**：redroid 自身 rc/gpu_config.sh 喺 early-init 後可能仍有消費者（display density / fps）— 冇 boot 測試唔刪，FINAL 實驗（刪後核 wm size 唔變） |
| (d) `ro.product.board`/`ro.board.platform` 補值 | (a) 派生（board = slug；platform = 品牌對應 SoC token pool，例骁龙系 freedreno token）| 低 | 低 — 純 ro.*；注意 ro.board.platform 有 native 消費者（media codecs 查 table）— 填 Snapdragon 代號可能觸發 codec 表查找偏差 → FINAL 觀察 media playback |

### 4.3 裁決
**本輪做 (a)+(b)**（全部經真機驗證過的 oemprop 鏈，boot 風險類 = 已驗證類；(d) 併入 (a) 但 board.platform 標 FINAL 觀察項）。**(c) 併 FINAL**。`ro.hardware` 本身唔使再郁（已生效）。

---

## 5. MAC 地址 / OUI

### 5.1 現狀（實證）
- 產品層零 MAC 處理（`redroid-service.js` grep 零命中）→ docker 默認生成。bridge 網絡默認 MAC = **`02:42:` + 容器 IP 後兩段 hex**（例 `172.19.0.6` → `02:42:ac:13:00:06`，stackoverflow 42946453；本項目設備網 `ensureDeviceNetwork` 專用 bridge，同機制）。
- 真機 s3-07b 冇 eth0 dump；本宿主主機 NIC 均本地管理位（c6:3e:…）— 宿主側 arp/bridge 表直接見到機房全部設備同 `02:42` 前缀。

### 5.2 檢測面
- **`02:42` = Docker 指紋級慣例**（serverside.com MAC 查證工具直接自動標記：Proxmox BC:24:11 / VMware 00:50:56 / KVM 52:54:00 / **Docker 02:42**；U/L 位=1 = 軟件賦值，查 OUI 必 miss）。
- 讀取面：機內 = `NetworkInterface.getHardwareAddress()`（ACCESS_NETWORK_STATE 即可讀 eth0）、`/sys/class/net/eth0/address`、`ip link`（同源 = 内核 netdev → **一处改全局一致**）。Android Wi-Fi/Bt MAC 系框架層隨機化（Android 6+），redroid 冇 wifi HAL → eth0 係唯一可見 NIC。
- 平台側：FB/GG 服務端睇唔到客户端 MAC（OSI 層隔斷）；風險全部喺**端側 SDK 讀 interface MAC** + 宿主網絡面（機房出口 ARP 表聚類）。
- 注意：手機 NIC MAC 本身係真實 IEEE OUI（burned-in，U/L=0）— `02:` 開頭已同真機唔夾（Android Wi-Fi 隨機化先會見 locally-administered，但 eth0 語義下真機雲手機唔會）。

### 5.3 路徑評估
| 路徑 | 內容 | 成本 | 風險 |
|---|---|---|---|
| (a) 產品層每身份 OUI 池隨機化：建機時由 identityId 確定性派生（`makeRng` 現有機制）從**手機廠商 OUI 池**（Xiaomi/Oppo/vivo/Huawei/Samsung/… 真實 IEEE 註冊段，repo 內 curated 靜態表）選 OUI + 24-bit NIC；落 DB（device 欄新增 nullable `macAddress`）；經 `NetworkingConfig.EndpointsConfig[devnet].MacAddress` 注入（bridge driver 支持自定義 MAC）；碰撞 = DB 唯一性檢查 + salt 重試（重試結果持久化 = 冪等重放） | 低 | 低：純 docker create 參數；唯一注意 = MAC 唔得同宿主/鄰居撞（L2 層）→ DB 唯一 + 池大（~20 OUI × 16.7M = 3.3 億組合，生日界安全）；同 egress 出口同一宿主橋接時 bridge 本身唔會撞自己 |
| (b) macvlan 網絡（設備直接上 LAN） | 架構改動 | 高 | 範圍外（egress 架構另有規劃） |

### 5.4 裁決
**(a)**。hermetic 測試覆蓋：OUI 池合法性（格式/U/L=0/非多播）、同 identityId 確定性、N=10k 身份零碰撞、非法輸入 fail-closed、重放冪等（同 row 同 MAC）。真機一致性（ip link == NetworkInterface == /sys）併 FINAL。

---

## 6. 匯總裁決 + S2 範圍

| # | 項 | 本單動作 | 層 | boot 風險類 |
|---|---|---|---|---|
| 1 | GL_RENDERER | image 字串 patch（lvp deviceName + mesa 露點，fail-closed patcher）； stealth=guest 規則入文檔 | image（新 tag） | 低（字串表類） |
| 2 | 傳感器 | 本單零改動；規格定案留 WA-VMSTEALTH-2 | — | （HAL/VINTF/sepolicy = boot 面，唔入本 tag） |
| 3 | 電池 | 產品層 `dumpsys battery` override（隨機 level + discharging + 微抖） | 產品 | 零 |
| 4 | ro.hardware 殘餘 | 派生欄擴展（flavor/description/product/分區變體/fingerprints/board）經既有 oemprop 鏈 + 載體 `--delete` 自清理；rc 重新生成 | 產品 + image（新 tag，rc artifact） | 低（真機驗證鏈） |
| 5 | MAC | 產品層 OUI 池隨機化 + DB 欄 + EndpointsConfig 注入 | 產品 + DB migration | 零 |

**新 tag = `14.0.0-240527-gms-mtg-oemprop-stealth`**（base = oemprop 最終 digest `2d82732b…`）：改動物全部屬「字串表 / 載體映射 rc / 斷言」類，無新 service、無 VINTF/sepolicy 改動 → 符合「零 boot 驗證可入新 tag」紀律；舊 tag 零破壞。任何偽裝生效宣稱 = NOT VERIFIED，FINAL 統一取證（getprop dump / dumpsys SurfaceFlinger / chrome://gpu / BatteryManager / ip link / getSensorList）。

### 6.1 FINAL 觀察項清單（本單預先規劃）
1. `getenforce`（決定 VMSTEALTH-2 sensors/battery-sysfs 可行路徑）
2. GL_RENDERER 實字串（guest 路徑下 ANGLE 包裹層仲唔仲露 `ANGLE (`/`Vulkan`）
3. `ro.boot.redroid_*` 刪除實驗（刪後 wm size/fps 不變先收）
4. `ro.board.platform` 填 Snapdragon token 後 media codec 行為
5. battery override 對 GMS 省電策略/同步行為無副作用
6. MAC 注入後 Streaming/adb/egress proxy 全鏈無回歸

### 6.2 參考（檢測面公開來源）
- ptkd.com/journal/android-emulator-detection（build props / hardware names / sensors / telephony 四大類）
- deepidsdk.com/blog/emulator-detection-guide（GL_RENDERER 黑名單；渲染性能 secondary）
- tajapps.com/blog/why-apps-detect-emulators.html（2026：GPU strings / ABI 暴露）
- medium @justmobilesec Bypassing Android Anti-Emulation I（ro.hardware/ro.kernel.qemu/build.fingerprint 實測）
- docs.bytehide.com emulator-detection（sensor availability / battery characteristics）
- serverside.com/tools/mac-address-lookup（02:42=Docker、U/L 位語義、hypervisor OUI 慣例）
- stackoverflow 42946453（docker bridge MAC = 02:42 + IP 編碼）
