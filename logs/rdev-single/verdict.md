# rdev-single Phase-1 收口 — 四類判定總表（2026-10-27，Kairo mvqgmpfasbh6p）

環境：單機 scratch（老細 17:13 批 8G → 17:31 再批 6G 口徑），兩部機 rdev-s1 (w1b-f1) + rdev-s2 (gms-mtg)。
每次 boot MemAvailable 實錄 = `logs/rdev-single/harness.log`。strata 端點，產品代碼默認 16G 未郁。

## 判定圖例：passed / implemented-unverified / known limitation / deferred（+ EXPECTED-BLOCKED / INCONCLUSIVE）

## P2 — W1b 真機段（docs/w1b-realdevice-todo.md）
| 項 | 判定 | 證據/備註 |
|---|---|---|
| R0-1 image digest | **passed** | w1b=9b0c697c3106 bit-同；實物 sha 三件套覆核 OK；**新發現**：該 image 的 rc 0664 group-writable → init 拒絕 = 舊 image 實測映射 DEAD；fix=finalize.sh → `w1b-f1`（新 digest 記錄在案） |
| R0-2 實物 sha | **passed** | oem-propctl-real=ea647e1b… ✓（R0-2 口徑=實物非 repo 檔） |
| R0-3 基線快照 | **passed** | p1/baseline-ram-usersnapshot.txt |
| R1-1 boot 帶 9 carrier | **passed** | p2/cmd-s1.txt + probe 斷言 |
| R1-2 早期映射實證 | **passed** | 9/9 ro.*==template（含 "Pixel 8 Pro" %20 解碼）；rc import 乾淨（v0「Skipping insecure file」對照組在 p2/r1-race-evidence-v0.txt）；映射早於 zygote64 **5.4s** |
| R1-3 負向 (a) 無 carrier | **passed** | 全部默認、boot 8s、rc 零 action |
| R1-3 負向 (b) 雜散 % | **passed** | 目標 prop 保留默認、boot 唔 loop；**隔離性加測**：同 boot 有效 carrier 照映射 |
| R1-4 boot 時長 | **passed** | carrier boot 8-21s vs 無 carrier 8s；rc parse 2ms；無異常（無 stock 同場基線 = 以無 carrier 對照代替） |
| R2-1 APK build | **passed** | 環境缺料（無 SDK/JDK）→ 可擷式 toolchain 解決；JDK17 hidden-API 修復 ×2（commit 5fe9ca1） |
| R2-2 裝機+dump 雙通道 | **passed** | 檔案通道需 adbd root（app uid 寫 /data/local/tmp 受控 = 記錄）；logcat base64 通道同場實證互核 |
| R2-3 probe-assert 9/9 | **passed** | VERDICT PASS，exit 0 |
| R2-4 自洽面覆核 | **passed（發現如實記錄）** | partition-split system/vendor/product/odm ×20 prop 全部 redroid 默認 = 未映射（L1 範圍外，餵 R5/L2）；telephony carrier 空（無 SIM 態） |
| R3 recreate 3× byte-identical | **passed** | boot1+3× recreate 共 4 份 dump，normalize（去 propCount/telephony）後全等 |
| R3 fleet ≥10 identity 抽樣 | **deferred** | 單機窗口无多 identity 平台 API；需 qwen27B/多機段 |
| R4 平台側閉環（migration/開關） | **deferred** | 本單範明冇帶 scratch API stack（RAM 口徑下只保兩機） |
| R5 L2 情報 | **passed（只讀採集部分）** | GL=radeonsi（AMD，跟 host 顯卡）；propCount 586；ro.hardware=redroid；/proc 穿透全家（meminfo/cpuinfo/uname/battery/df）；/vendor 可見性未測（需 root app 對照）→ 剩餘部分 implemented-unverified |
| R6 收口 | 本檔 = R6-1 輸入；R6-2 decision paper 待老細 | |

**W1b 生產開關建議**：R0-R3 真機項全綠（fix=f1 image）→ **解鎖條件已備**（R6-2 拍板材料齊）。
**必修**：finalize.sh 入 build 流程（否則任何 group-writable checkout 出產嘅 image 映射靜默死）。

## P3 — T1 GMS-MTG（docs/t1-gms-realdevice-todo.md）
| 項 | 判定 | 證據/備註 |
|---|---|---|
| R0-1 digest | **passed** | gms-mtg=02ab5675ba15 ✓ |
| R0-3 隔離設備 | **passed** | rdev-s2，無 template/ro overrides |
| R0-4 出料口 | **passed** | ICMP 局部封鎖唔準；host 直連 204//checkin=400/mtalk OK + 機內 DNS 解析實錄 = 網絡層通 |
| R1-1/2 開機+穩定 | **passed** | boot 4s；在線 19+ min 無 restart |
| R1-3 分區實證 | **passed** | 三 APK 路徑齊 + packages gms/vending/gsf 齊（symlink merge runtime 驗證） |
| R2-1 Phonesky | **passed** | vending 自啟 + UnauthenticatedMainActivity 顯示 |
| R2-2 進程就緒 | **passed** | persistent/main/unstable 全列 |
| R2-3 gservices live | **passed** | provider 有應答（表空=checkin 前） |
| R2-4 checkin/androidId | **FAIL（根因採集完成）** | android-id=0、consistency token empty、phenotype 29504；網絡層已排除 → 根因指向 **GMS 簽名/認證面**（uncertified device，GservicesChecks 語義）非 redroid base —— gms-variants §2 鑑別診斷：MTG 呢步紅，按紀律「根因歸 redroid base」要修正：網絡通 + 進程/分區全綠 = 根因在 **認證/簽名層**（redroid 未過 Google 認證嘅後果，microG 對照 deferred 先至能二分「版本老 vs 認證」兩因） |
| R3 Gmail | **EXPECTED-BLOCKED** | checkin 斷鏈（登入前置）+ 人工登入需要老細喺場；機械可及點 = Store UI 截圖（store-main.png，screen-sleep 態記錄） |
| R4 WhatsApp/native 矩陣 | **deferred** | 本單未列；Bromite 裝機成功已側證 x86_64 app 安裝鏈 OK |
| R5 Integrity | **INCONCLUSIVE** | 缺料清單：無 prebuilt demo APK；atom.attest.BIND 無 resolver；GMS 22.21.16（2022 wsa 版）；android_id=0 前置斷鏈。重跑條件 = build integrity sample + 新 GMS 版 |
| R6-4 teardown | 本收口執行 | 見零殘留核 |

**MTG 結論一句**：裝機/進程/UI 全綠，**Google 後端握手（checkin）斷喺認證面** = 同 gms-variants §1e 預期（Integrity FALSE）同源的更深層實證；Gmail 路線喺 MTG-uncertified 形態下 = 唔通（後端拒絕，非本地故障）。

## P4 — 曝露採集
| 項 | 判定 |
|---|---|
| 探針頁機上渲染（Bromite） | **passed**（Chrome 真 APK 公共源全部不可達 = known limitation，Bromite 108 x64 代替 + 誠實標注） |
| web JSON 全量採集 | **passed**（host headless 雙 context；機上瀏覽器 JSON 提取 = EXPECTED-BLOCKED 無 console 通道） |
| Android 擴充面 dump | **passed**（settings/sensors/battery/df/meminfo/cpuinfo/uname/GL 兩路徑） |
| 紅旗表「實測」欄回填 | **passed**（exposure-surfaces.md 附錄 A） |
| WebRTC 機上候選 | **passed**（截圖含 192.168.250.16 內網候選；生產出口=不同代 記 N4/N5 待真機段） |

## P5 — T2-E 單機項
| 項 | 判定 |
|---|---|
| dataDir 保留斷言 | **passed**（marker + settings global/secure + 已裝 app  survive rm+recreate；bluetooth_name 被 BT 棧重置 = 記錄） |
| 登入狀態流轉（API 級） | **EXPECTED-BLOCKED**（需平台 API stack + 帳號，超出單機窗口範圍） |
| 審計落地 | deferred（跟 API 段） |

## RAM 紀律實錄
- 17:05-17:23 gate 16G 期：14.8→10.9Gi 未達，零硬啟 ✓
- 17:13 老細批 8G；17:31 批 6G（產品默認 16G 未改代碼 ✓）
- 每 boot MemAvailable：harness.log（s1 首次 11654、s2 10960、P5 重啟全部 ≥8.7Gi）
- 每機實際 footprint ≈ 0.9-1.2Gi（預算 2.5 保守，L2 動態 gate 可用實測曲線）
