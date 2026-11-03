# WA-FIXALL S6 — stealth4-next bundle (gen6) 結果

日期: 2026-11-03 (Asia/Hong_Kong) · 試胎 = **rdev-fx2**（image `...-stealth5` @ `2de5d82a`，fresh-data 首 boot）· 對照 = **rdev-fx1**（stealth4，凍結不動）· D4 冇 submit ✓

## 一句總結

**bake 已中嘅**: build 形态 user/release-keys + 去 su、sim.state=ABSENT、R57/R58 proc 載體扳（7.6GB / 8 核 ARM 假 cpuinfo / Ryzen 名清零）、locale carrier 落地、carrier sweep 生效。
**bake 未中（誠實記帳）**: ro.debuggable=0（redroid 上不可行）、R41 WebView（translator 缺）、R59 battery EXTRA（HAL update 环）、sensors fake HAL（照工單規則排底）。
**DevCheck**: **10/100 = 對基線零移動** — 原因 = score 被「cloud phone」verdict cap 死喺 10（見下）。

## S6 三大發現（全部 on-device 實測，fleet 級根因）

1. **fresh-data 首 boot 嘅 property reload 會抹走所有 early-init propctl 寫入**。
   容器 /data 新淨 = init 喺 `post-fs-data` 段跑 `load_persist_props` builtin = 重宣 build.prop defaults + 重置 persist 區。
   實測: stealth5 v3 前 fx2 用舊 phase rc 開機 → carrier 全在、propctl 有跑，但 `ro.product.model`=redroid14_x86_64、brand=redroid、serialno 空、fingerprint=redroid 原版 — **故事全家被抹**；fx1（舊 data）同一 rc 全部倖存 → **呢個缺陷一直Hidden，只喺每台新機 first boot 出現 = 全部新 create 中招**。
   **Fix（已落地）**: `rcPhaseFor` = ro.* 同 persist.* 一律去 `load_persist_props_action`（reload 之後、zygote/class_start core 之前）；生成器 + 兩份 rc artifact 重造（63 行全轉 phase）+ CI drift/parse 校驗更新（tamper 樣本反轉）。Suite 1764/1758/0/6 零回歸。
2. **init 對 rc 檔「Skipping insecure file」**：COPY 入面 mode 0664（group-writable）→ init 靜默跳過成個檔 = 所有 trigger 無運行（fx2 v2 全 carrier no-op + carrier 無 sweep）。Fix = build context chmod 0644 + post-build assert（merged view 度 `stat` mode）。
3. **oem-proc-view.sh 喺 init（umask 077）下 render 出 0600 檔案 + 0700 目錄** → /proc/meminfo 對非 root 不可讀 → system_server 喺 `ProcessList.<init>` 「SysMemInfo read failed」crash-loop（zygote restarting，boot 永不完成）。Fix = script 內 `chmod 755 $DIR` + bind 前 `chmod 644 $DIR/{meminfo,cpuinfo}`；host stub test 21/21。呢個缺陷代表 **波2 proc-view 從來冇真正喺 init 下跑過**（舊驗證 = host shell umask 022 盲點）。

## 逐項評分（工單 bundle 對照）

| 項 | 結果 | 讀值/證據 |
|---|---|---|
| build 形态 ro.build.type | ✅ `user`（fx1 對照 userdebug） | fx2-props.txt |
| build 形态 ro.build.tags | ✅ `release-keys`；fingerprint 段 `:user/release-keys` | fx2-props.txt |
| build 形态 su | ✅ 去咗（whiteout；fx1 對照有 /system/xbin/su） | fx2-props.txt |
| build 形态 ro.debuggable=0 | ❌ **不可行，回退 = 1**：單行扳 0 → init 約 7 秒 exit 129（redroid adbd = init `critical` service + 平台條手系 adb）= 對老細拍板嘅**記錄在案偏離** | build-record.md; bisect 實測 |
| R41 WebView arm64 | ❌ **未中（回退）**：呢個 image 家族 `ro.dalvik.vm.native.bridge=libnb.so` = null-bridge（冇 libndk_translation、冇 nativetranslate APEX）→ arm64-only APK 裝得但 dlopen 死（WebViewFactory「No WebView installed」）→ 回退 base com.android.webview 125 = webview 存活。**R41 = 下一版 translator 三件套（translator .so + bridge prop + abilist）**；vendored APK+pin 留低待用 | build-record.md |
| R57 /proc/cpuinfo | ✅ Ryzen 名清零（假 ARM cpuinfo：8 核、CPU part 0xd48、零「model name」行） | fx2-props.txt |
| R58 MemTotal | ✅ 94GB → **7,650,410 kB**（載體 `oem_mem_total_kb` 由 create path 自動注入；fx1 無載體 = 94G 對照） | fx2/fx1-*.txt |
| R42 sim.state | ✅ ABSENT（bake rc boot_completed trigger） | fx2-props.txt |
| R50 locale carrier | ✅ 生效：機上 `ro.product.locale=ru-RU`、SetupWizard UI 俄文（值 = profile seed；**HK 屬地 story 嘅 device 層一致性 = 剩低嘅 story-override channel gap**，三連 gate 欄位真相照 P2） | fx2-props.txt |
| R59 電池哨兵 | ⚠️ **部分中**：層判定 = image health-HAL（product script 讀唔到寫唔入 voltage）；fake psy bind 語義 **runtime 驗證成功**（voltage_now=3895000 讀到）；但 init builtin mount 線未落地 + example HAL 開機讀空目錄之後唔再 update → BatteryService 照哨兵。**兩件 pending 排下一版** | fx2-battery.txt |
| sensors fake HAL（R48） | ⏸ 誠實排底（冇可信 x86_64 AIDL prebuilt；照工單「搞唔掂排下一版寫明」）；DevCheck 因此 -15 | 本文 |
| P1 RAM gate 2,500MiB | ✅ DB config（`ram_gate.config` postBootTargetMiB）；gate 語義測試核過（boundary 13200 DENY/13400 ADMIT） | 本節 |
| P2 fx-2 人卡三連 | ✅ DB: gate 欄 tz/locale/region = HK story + `expected_egress_ip` = 實測出口（gost socks5）；boot carrier 值 = seed（America/Sao_Paulo / ru-RU）= 上面 story-override gap 一條數 | 本節 |
| P4 電池層判定 | ✅ 判定完成 = image 層（見 fx2-battery.txt） | ✅ |

## DevCheck 前後對照（基線 Trust 10/100，gen4）

fx2 裝 DevCheckAI（com.deviceinsight.ai）→ 主頁 Trust = **10/100**「Not a genuine device (Cloud phone)」→ 卸載 ✓。
**零移動係點解**: breakdown 顯示 score 被 cloud-phone verdict **cap 喺 10**，扣分五條 =
`x86_abi:x86_64`(−25)、eth0 有線(−25)、核心 sensor 缺席(−15)、model 唔喺 device db(−3)、USB debugging(−3)。
即係:**S6 修好嘅 CPU/RAM/sim 全部唔解 cap；要郁分要食 x86_64(=R41 translator)、eth0(新細項 R6x 記帳)、sensors(已排底) 呢三舊** → 分數回升 = 下一版嘅功課，方向明確。

## 讀值檔案

`fx2-props.txt`（prop+proc+webview）、`fx2-battery.txt`、`fx1-control-reads.txt`（對照組，未碰）、`fx2-devcheck-main-ui.xml`、`fx2-devcheck-trust-detail.xml`。

## 試胎迭代成本（anti-loop 帳目）

bake v1(debuggable 殺 init)→v2(rc 664 insecure)→v3(ro.* phase fix)→v4(webview 回退)→v5(battery mount 方向)→v6(proc-view 入圖)→v7(.sh umask chmod) = **7 bake / 7 create**，每輪根因唔同（非同一錯誤重試）；每步有讀值推進。fx2 終態：device `0c553d4f`，running，adb 15001。

## 接力剩乜（下一版 backlog，按影響排序）

1. **phase-fix rc 入其他 image**：stealth4/w1b 舊 image 嘅新 create **照中 fresh-data wipe**（fix 喺 repo 層；要一次 COPY-only bake 先落到機）。
2. **battery EXTRA 兩件 pending**（init mount builtin 失敗因由 + HAL update 環）→ 電池讀值同 DevCheck −?。
3. **translator 三件套**（R41 + 消 `x86_abi:x86_64` cloud tell 一半）。
4. **sensors fake HAL**（−15）。
5. **eth0 tell**（新細項：redroid NIC 名 = eth0；手機 = wlan0 語義）。
6. **R50 story-override channel**（profile story tz/locale vs seed 值嘅 device 層一致性 = product gap）。
7. extras rc 自帶 carrier（`oem_ro_stealth4_*` 8 個）無人 sweep = 舊細項照記。
