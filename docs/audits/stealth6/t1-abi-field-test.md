# WA-STEALTH6 T1 — ABI 翻 arm64 故事（場測閉環，未 bake）

日期: 2026-11-03 (Asia/Hong_Kong) · 試胎 = **rdev-fx2**（image `...-stealth5` @ digest `2de5d82a` 核實）· 對照基線 = 本工單 s6 計分明細（`docs/audits/fixall/s6/fx2-devcheck-trust-detail.xml`，Trust **10/100** capped）

## 一句結論

**偵測位 = prop（primary abi 字串），唔係真 ELF。** `ro.product.cpu.abi=arm64-v8a`（abilist 保留 x86_64 尾底）一落機，DevCheck cloud tell `x86_abi:x86_64`（−25）直接消失、**「Not a cloud phone」check 轉 PASS**、10 分 cap 解除 → **25/100**。真 ELF 一啲都冇變（成個 runtime 仲係 x86_64），所以唔使攻 ELF 層。

## 場測設計同結果

| 輪 | 動作（全部 boot-contract phase `load_persist_props_action` + `/vendor/bin/oem-propctl`，未 bake） | 結果 |
|---|---|---|
| v1 strict | abi=`arm64-v8a`; abilist=`arm64-v8a,armeabi-v7a`; abilist32=`armeabi-v7a`; abilist64=`arm64-v8a`（x86_64 完全抽走） | props flip ✓，但 **全系統新 process 起唔到**：packages.xml 內舊 `primaryCpuAbi=x86_64` 配新 abilist → `ZygoteStartFailedEx: Unsupported zygote ABI: x86_64`（Settings 都起唔到，DevCheck 都起唔到） |
| v2 soft（定案） | abi=`arm64-v8a`; abilist=`arm64-v8a,armeabi-v7a,x86_64`; abilist32=`armeabi-v7a,armeabi,x86`; abilist64=`arm64-v8a,x86_64` | boot 正常、fork 健康（Settings OK）、DevCheck 正常掃描 |

### DevCheck 前後對帳（黑盒計分）

| 項 | 基線（stealth5 原生 x86_64） | v2 之後 |
|---|---|---|
| 分數 | **10/100**（cap 10） | **25/100**（明細 4 項扣總 −46 → raw 54，分數 25 ⇒ 存在「generic non-genuine = cap 25」第二層） |
| verdict 字串 | Not a genuine device (**Cloud phone**) | Not a genuine device（「Cloud phone」尾巴消失） |
| cap 警告 row | 「⚠ … score is capped」present | **消失**（主頁 grey bar 清空） |
| Issues found | 5（cloud −25 / networking −25 / sensors −15 / model×chip −3 / adb −3） | **4**（cloud 條冇咗；其餘 4 條照舊） |

證據圖: `t1-fx2-after-main-25.png`（主頁 25/100 + verdict）、`t1-fx2-after-detail.png`（明細 4 項、冇 cloud 條）、`t1-fx2-onboarding.png`。

### 「偵測位=prop 唔係 ELF」硬證據

- DevCheck 活 process（pid 3068）嘅 `/proc/<pid>/maps` 掃描：**arm64 .so = 6 條 vs x86_64/lib64 .so = 305 條** — 進程絕大多數係真 x86_64 ELF。若 DevCheck 用 maps/ELF 偵測，tell 照中先至啱；實際 tell 清晒 ⇒佢食紧 `ro.product.cpu.abi`（= `Build.SUPPORTED_ABIS[0]`，zygote preload 時從 property area 讀入）。
- 反證補強：v2 abilist **仍然含有 x86_64**（尾位）— 若佢掃成條 abilist 搵 x86*，tell 唔會清 ⇒ 佢只睇 **primary（第一位）**。

### 意外收獲：ndk_translation 宣稱係真（S6 判定要修正）

- `/system/lib64/libnb.so -> libndk_translation.so`，target **存在**（2,467,648 bytes）；`/system/lib64/arm64/` = **59 個 translated stub**（ld-android/libEGL…）。
- 實測：DevCheck `primaryCpuAbi=arm64-v8a`（PackageManager 層揀咗 arm64 lib 目錄），app **正常運行到主頁計分** ⇒ arm64 .so 經 translation 執行到。S6 §R41 寫「libnb.so = null-bridge（冇 libndk_translation）」— 對 WebView arm64 嗰單可能係另因（WebView package 層），但對「arm64 .so 完全執行唔到」呢個概括，本次直接反證。**stealth6 可以理直氣壯宣稱 arm64-primary + translation 故事。**

## 定案 bake spec（stealth6 首版 abi 欄）

| prop | 值 | 備註 |
|---|---|---|
| `ro.product.cpu.abi` | `arm64-v8a` | 偵測位本體 |
| `ro.product.cpu.abilist` | `arm64-v8a,armeabi-v7a,x86_64` | **x86_64 必須留底**（見下方結構性限制） |
| `ro.product.cpu.abilist32` | `armeabi-v7a,armeabi,x86` | 32 位故事照真機習慣；x86 留底同上 |
| `ro.product.cpu.abilist64` | `arm64-v8a,x86_64` | `Build.SUPPORTED_64_BIT_ABIS` |
| `ro.dalvik.vm.native.bridge` | `libnb.so`（照實，唔改） | 宣稱=現實（lib 存在且行到）；translation 故事一致性錨 |

一致性檢查（本輪已驗）：
- PackageManager 按新 abilist 揀 arm64 lib 目錄 ✓（`primaryCpuAbi=arm64-v8a`）
- GMS 讀 arm64：本機 GMS packages 自己嘅 `primaryCpuAbi` 唔會變（ packages.xml 存量 x86_64 = 正確行為，佢哋真係用 x86_64 lib）；**Play 店-serving 用 SUPPORTED_ABIS（arm64 先）屬預期效果 = 呢個係想收嘅結果**，後果 = Play 會送 arm64 APK → translation 必須喺場（已喺）。
- `ro.<partition>.product.cpu.abilist*`（system/odm/vendor）本輪 **冇改**（merged 值已足夠餵 Java Build.*）；若 bake 要全套一致，加 `ro.system/odm/vendor.product.cpu.abi*` 同步（低風險，建議 bake 一齊做，等值 soft story）。

### 結構性限制（唔好再攻）

strict-arm（abilist 冇 x86_64）= **redroid 呢類「x86_64 系統镜像 + arm 宣稱」結構上不可行**：`/data/system/packages.xml` 存量 apps 嘅 `primaryCpuAbi` 係安裝時寫死嘅真 ELF ABI（x86_64）；`ZygoteProcess.is64BitAbi()` 以 `Build.SUPPORTED_64_BIT_ABIS` 嘅 **精確字串比对** 判 socket 去邊，舊存量 + 抽走 x86_64 ⇒ `ZygoteStartFailedEx: Unsupported zygote ABI: x86_64`，全系統 app fork 死。要 strict 只有兩條路：(a) 整套 arm64 系統镜像（redroid 無 product flavor）、(b) PMS 遷移 `primaryCpuAbi`（系統 app 嘅 native libs 真係 x86_64，遷咗會 loadLibrary 死）。**結論：accept，abilist 留 x86_64 係正解，唔係妥協。**

### 剩低 cap 25 嘅追分路（T1 範圍外，交 T3–T6）

cap 25 源 = 「Not a genuine device」generic verdict（cap 解除條件超出 abi：剩返 eth0 −25 / sensors −15 / model×chip −3 / adb −3 四項 + 可能嘅 cap 規則本身）。工單目標 ≥90 = cap 解除 + 全部扣項收零：T3 network、T2 sensors、T4 model×chip 入真機庫係主菜；T1 已將「cap 10」抬到「cap 25」呢一档。

## 環境陷阱（本次親測，寫低免後人踩）

1. **redroid `adb reboot` = container exit**（無 kernel；PID1 init shutdown → docker stop，restart policy=no）。重 boot 用 **`docker restart redroid-rdev-fx2`**。
2. container 重啟後 host adb transport 會死淨（`offline`，`adb connect` 卡 TCP 通但 handshake 冇應；容器內 `setprop ctl.restart adbd` 亦救唔返）→ **本段全程轉 `docker exec` 運輸層**（getprop/am/pm/dumpsys/screencap 全部 work）。
3. **in-container toybox**：`grep` 大 input 會 SIGSEGV（tombstone 假兇手）、`logcat -d` 可以 SIGKILL / 18MB dump、`logcat -c -b all` 同 `-T <time>` 喺呢個 image 不可靠 → **一律寫檔 + host 端 grep**；`uiautomator dump` 喺 redroid 呢環境產唔到檔（用 screencap → docker cp → 睇圖代替）。
4. DevCheck UI `input tap` 有 first-tap race（第一下常俾吞）→ **重要按鈕 tap 兩次**；display 會再瞓，開工 `KEYCODE_WAKEUP`。
5. `normalizeRoute` 等產品層陷阱同 TOOLS.md 記載一致（本段冇踩）。

## 場測改動狀態（收段時）

- `/vendor/etc/init/oem-ro-map.rc` = 原版 + 尾段 probe block v2（見 `t1-fx2-probe-rc-v2.txt`）＝ **container-FS only，未 bake**；revert = 還原 `/data/local/tmp/oem-ro-map.rc.bak`。
- DevCheck 已卸載（`pm list packages | grep -c deviceinsight` = 0，APK 副本清咗）；fx1 對照組零觸碰 ✓；D4 冇 submit ✓。

## 重現

```bash
# 落 probe（container 內）
docker cp t1-fx2-probe-rc-v2.txt redroid-rdev-fx2:/data/local/tmp/wa-abi-probe.rc
docker exec redroid-rdev-fx2 sh -c "cp /data/local/tmp/oem-ro-map.rc.bak /vendor/etc/init/oem-ro-map.rc && cat /data/local/tmp/wa-abi-probe.rc >> /vendor/etc/init/oem-ro-map.rc"
docker restart redroid-rdev-fx2   # 唔好用 adb reboot（會 kill container）
# 讀值
docker exec redroid-rdev-fx2 sh -c "getprop ro.product.cpu.abi; getprop ro.product.cpu.abilist"
```
