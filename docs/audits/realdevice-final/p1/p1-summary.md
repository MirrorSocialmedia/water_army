# P1 單機全流 — redroid-rdfa-01（2026-10-28 20:33–20:55 HKT）

## 機器
- 設備 ID: `8b1ac9d2-4c8c-4063-94ab-937f463f381f`，容器 `redroid-rdfa-01` (`9599ab23…`)
- 模板 `mc-dogfood-gmsmtg` → image `water-army/redroid:14.0.0-240527-gms-mtg`
- 身份 `9c931b40-a100-4300-906b-232c97e413ec`（redroid-rdfa-01, qa_device，建機時綁定）
- adb 127.0.0.1:15000（host platform-tools 直連；api 容器無 adb = 平台 ADB 區結構性 ADB_UNAVAILABLE）

## 八步斷言

| # | 步驟 | 斷言 | 結果 |
|---|------|------|------|
| P1.1 | 建機 | POST /api/devices/redroid 200，containerState=running，roOverrides 12 項注入 device row，identity 綁定 | **PASS** |
| P1.2 | 健康 | 平台 containerState=running；UI 顯示 RUNNING；平台 adb 探测=unknown（api 無 adb，結構性） | **PASS（注記：平台 adb 面 ADB_UNAVAILABLE）** |
| P1.3 | boot | host adb `getprop sys.boot_completed`=1（建機後 ~10s 輪詢即 1） | **PASS** |
| P1.4 | 指紋 | profile 12 項 ro.*/persist 對機：host adb 12/12 不符；in-app wa-probe（591 props ground-truth）0/12 match | **FAIL — KNOWN LIMITATION（根因見下）** |
| P1.5 | egress | 機內 traffic 經 gost 18443 出口 = 103.194.185.206（= P0 gost egress IP）；GMS global http_proxy 設定成功；UI/API 面 503 EGRESS_BINDING_DISABLED（開關未開，fail-closed by design） | **機制 PASS + 平台面 503（by design）** |
| P1.6 | APK | 平台面 503 APP_OPS_DISABLED（W2 開關未開，fail-closed）；host adb 安裝 wa-attest + wa-probe 均 Success；兩 probe 啟動成功並產出 | **機制 PASS + 平台面 503（by design）** |
| P1.7 | live view | POST /streams 503 STREAM_TICKET_UNAVAILABLE（STREAM_TICKET_SECRET 未配置）+ api 無 adb 無幀源 → 結構性不可用；UI fail-closed 顯示（非白屏）；真幀用 host adb screencap 補 | **FAIL — 結構性限制（雙層：無 ticket secret + 無 adb）** |
| P1.8 | RAM gate | liveLeases 1→2、running=2、reservedMiB=2400、memAvailable 45023→43225 MiB、wouldAdmitNext 仍 true | **PASS** |

## P1.4 根因（指紋注入 — 精準）
- **carrier 100% 送達**：container Cmd 22 個 `androidboot.oem_*` 全數在機內 map 成 `ro.boot.oem_*`（實測全對）。
- **display spec 生效**：wm size 1080x2400、density 420（L2w2 ADR-033 deviceSpec 真生效 ✅）。
- **最後一步缺**：MTG GMS 影像**無 oem-propctl 二進制**（/system/bin、/system/xbin、/vendor/bin、/system_ext/bin 全無）+ 無 oem init rc → carrier 值停在 ro.boot.oem_* 生值，實際 ro.*/persist.sys.timezone 保留影像默認（redroid / GMT）。
- 結論：W1b 注入管線 = 建機 carrier ✅ → kernel→init mapping ✅ → **影像內解碼器缺（MTG 影像未內嵌 oem-propctl）** ❌。= 工單預期的「MTG 已知 ro.* 寫失敗」，現定位到解碼器缺失。

## P1.6 附加（attest 真機實測結果）
wa-attest 完整跑 55s（logcat WA-INTEGRITY 6 段 JSON）：
- gms probe: OK — GMS 22.21.16 / Play Store 30.4.17 / gsf 14（MTG 影像 GMS 真在）
- bind: atom.attest/safetynet/zinzi 全 NO_RESOLVER
- legacyapi: StandardIntegrityManager present，prepareIntegrityToken → -9（Play Store 服務 binding 失敗）
- safety (SafetyNet): task_error unknown/incomplete
- integrity (Play Integrity API): task_error **-12 Google internal server error**
- = MTG 真機上 GMS 存在但 Play Integrity/SafetyNet 判決拿不到（-12 伺服器錯 + -9 binding）。照實記錄。

## 證據檔（logs/realdevice-final/p1/）
- p1-00 gate before / p1-01 provision / p1-02 fingerprint profile JSON
- p1-03/04 指紋 UI 截圖（loaded + ensured，碰撞審計 blocking=false）
- p1-05 create 回應（roOverrides 12 項 + preflight）
- p1-06 容器+RAM / p1-07 boot poll / p1-08 API 健康+refresh（ADB_UNAVAILABLE）
- p1-09 getprop 12 項 / p1-10 injection forensics（Cmd carrier + oem-propctl 缺失）/ p1-11 ro.boot.oem_* mapping + wm size
- p1-12/13/14/15/16 egress 網路拓撲+可达性+route e2e（103.194.185.206）/ p1-17 GMS proxy set+API 503 / p1-18 identity egress GET+PUT 503
- p1-19/20 設備 UI overview + console（live view fail-closed 截圖）/ p1-21 平台 install 415→p1-22 503 APP_OPS_DISABLED
- p1-23 host install / p1-24 probe logcat / p1-25 probe dump 解碼 JSON / p1-26 in-app 0/12 比對
- p1-27/28 attest 全跑（WA-INTEGRITY JSON）/ p1-29 screencap 真幀 / p1-30 display 驗證
- p1-31 gate after（liveLeases 2）/ p1-32 Apps tab UI 截圖（W2 disabled card）
