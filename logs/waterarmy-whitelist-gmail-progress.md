# water_army 白名單效果驗證 + Gmail 登入機械鏈 — progress（2026-10-27 夜）

CTO 執行單（Kairo `mvq6ruosnqkck` T1 真機段 + `mvqgmpg7w82rk` L3 延續；老細 22:42 確認舊 AID 已在 google.com/android/uncertified 註冊，「繼續吧」）。**狀態：A/B COMPLETE，C = EXPECTED-BLOCKED（交出席清單），D 見文末。**

## 紀律記錄

- boot 前 RAM 實測：MemAvailable=9580→9537 MiB（gate=6144+2560 budget → projected 6977 ≥ 6144 PASS，記入 harness.log）；同時 1 部；Kairo 9800 零寫；用戶 stack（mihomo/water-army-*）零動。
- secrets：checkin token / AID-token、email、url query string 入檔前 mask（`w1-Checkin-masked.xml`、`w1-checkin-id-token-masked.txt`、logcat sed mask）。
- 連敗停手：Gmail APK 外部來源 4 路（apkpure 直連+proxy=CF 403 challenge、apkcombo=proxy 000 timeout、matlink token dispenser=404、npm "apkeep"=佔名 placeholder 包）→ 停止再試，記錄不硬凹。

## A. 白名單效果驗證 — 判定：**部分成功 + INCONCLUSIVE（設計使然，誠實記錄）**

rdev-f1（`water-army/redroid:14.0.0-240527-gms-mtg`，默認 CMD，EGRESS_PROXY=1，datadir=/tmp/rdev-single-state/f1-data 全新）：

1. **Checkin Succeeded 再現 ✓**：boot+~2min natural reason-1 POST `https://android.googleapis.com/checkin` → `Checkin Succeeded (fragment #1)`（logcat 14:48:01，0.4s 級）。判據 = `files/checkin_id_token` + `Checkin.xml`（android_id/versionInfo/deviceDataVersionInfo 三樣齊）。
2. **關鍵發現（whitelist 驗證的結構性障礙）**：EXP-2b teardown 時 e1 datadir 已清，**老細註冊的 AID 3916878313160989068 隨舊機死咗** — 新機 fresh datadir 必派**新 AID**。本機新 AID = `3929395759228143973`（未註冊）。→ 「註冊前後 response 欄位對比」需要（a）將新 AID 都註冊咗，再（b）等 Google 側異步生效後覆檢 checkin response / Play 設備目錄。**觀察點俾之後覆檢**：`Checkin.xml` deviceDataVersionInfo 值 + `last_checkin_ms` + Play Store 可見 app 目錄變化。
3. **新一輪 checkin 觸發失敗（誠實記錄）**：`docker restart` 後 reason-1 **無自然復發**（EXP-2b「gen-cmd/排程 flaky」觀察第三次重現）；shell 重播 BOOT_COMPLETED = SecurityException（uid 2000 無 permission 發此 broadcast，EXP-2 舊脚本嘅呢步其實從未生效過 — 已記錄）；直接 poke CheckinService = 已知 FGS crash 雷區，冇踩。→ 下一輪 checkin 提議等 boss 登完帳號自然觸發（AccountManager 註冊會 drive gservices/checkin 週期）或第二日覆檢。
4. token 文件 R2 後 md5 不變（`1cf0c1f9…`）= 無新 checkin 寫入，自洽。
5. **强制觸發機制窮盡（誠實）**：`dumpsys jobscheduler` 實測 GMS **冇任何 pending checkin job**（dump 內無 gms job 條目）= reason-1 係一次性 boot 排程，shell 層無法安全 force（JobschedulerService poke 都無 handle；FS poke = FGS crash 雷區）。下一輪 checkin = 下次 cold restart / 登帳號後 gservices 週期。

## B. Gmail/登入機械鏈 — 推到人工牆 **✓ EXPECTED-BLOCKED**

- 屏幕預設 Asleep（redroid 無顯示 HEADLESS 常態）→ `input keyevent WAKEUP` + `wm dismiss-keyguard` 先搞得郁 UI；b1/b2 兩張黑屏 = 睡緊（唔係 crash，已重拍）。**坑位記錄**：headless redroid 做任何 UI 流之前必先 WAKEUP。
- Play Store 入口：launcher intent 會先被 **SetupWizard WelcomeActivity 截胡**（MTG 首啟精靈），force-stop setupwizard 後先入到 `AssetBrowserActivity`。
- Store 首屏 = 未登入 CTA「Sign in to find the latest Android apps…」→ tap Sign in [360,906] → **GMS `MinuteMaidActivity`「Sign in - Google Accounts」**：email 輸入框 + Next/Forgot email?/Create account = **帳號/密碼人工牆**（b4→b7 逐屏存證；b5=b6 靜態同幀）。
- **鏈路通機械證據**：MinuteMaid WebView（chromium M118，GMS 程序內）實際渲染 Google 登入頁 = accounts.google.com TLS 往返回到；宿主 `ss` 實測 device(172.38.223.2)↔gost(172.38.223.1:18443)↔mihomo(127.0.0.1:7897) established 連接。logcat 無明文 accounts.google.com URL 行（chromium 唔 print URL at default level）— 以「渲染成功 + 活 TCP 鏈」為證據鏈，標注：logcat-level 端點字串 = 未 capture（chromium verbose 未開，下次可 `--enable-logging --v=1`）。
- **Gmail app**：mtg image **冇預裝**（pm list = gsf/vending 得）。Play Store 裝機 = 要先登入（雞同鴨牆，即同一道人工牆）；宿主 sideload 來源全_dead_（見紀律）。**Gmail 入口 = 同一道牆（GMS AccountManager），無額外機械步可推**。
- 邊個先到牆：**Store 入口先到**（Sign in tap 後 12 秒內到 MinuteMaid 牆）。Gmail 未装 = 到唔到自己嘅牆，但佢嘅牆就係 GMS 牆。

## C. 老細出席清單（人肉 30 分鐘）

**前提**：機 rdev-f1 保留開住（見 D）。adb 口徑：`~/.local/share/platform-tools/adb connect 127.0.0.1:16512`。

1. （2 分鐘）確認屏亮 + 喺登入牆：`adb -s 127.0.0.1:16512 shell input keyevent KEYCODE_WAKEUP; adb -s 127.0.0.1:16512 shell dumpsys window | grep mCurrentFocus` → 應該見 `MinuteMaidActivity`。若唔在：monkey 起 vending → force-stop `com.google.android.setupwizard` → `am start -n com.android.vending/.AssetBrowserActivity` → tap「Sign in」。
2. （5 分鐘）建議先做**白名單補註冊**：瀏覽器開 `google.com/android/uncertified`（用你要登入嗰個 Google 帳號！），Add by (Android) ID：**`3929395759228143973`**（本機新 AID；註冊生效 async 數小時）。
3. （10-15 分鐘）手機端流：喺 MinuteMaid 牆輸入帳號 → Next → 密碼 →（有機會要過 2FA/手機驗證 prompt — 呢個 app 本身冇問題，redroid 純淨環境 Google 好大機會 trigger 額外驗證，属正常）。
4. （5 分鐘）登入成功後 Store 會問 sync/backup 之類 → 一律 Yes/Next 得。
5. （5 分鐘）装 Gmail：Store 搜尋 Gmail → Install → open → 跟住佢行到收件匣（收件匣出現 = 人工斷言完成）。

**我哋之後機械斷言（登入成敗判據）**：
- `dumpsys account` 出現 `Account { … com.google …}`（baseline 已拍 = `Accounts: 0`）；
- gms auth tokens db：`docker exec rdev-f1 ls -la /data/data/com.google.android.gms/databases/` 增長 + `content query --uri content://com.google.android.gsf.gservices` 有帳號相關 key）；
- MTG 注意：gsf googlesettings.db 照 EXP-2b 教訓唔好當判據；
- Gmail 收件匣截證：`screencap` 存檔入 evidence。

**風險预告**：uncertified 設備登入後，Google 有可能照樣收得到但不給某些服務（Play Integrity 舊版 = 白名單只管「設備可見性」）；Gmail 本身唔使 certified 都用得。

## D. 收口安排

- **留機**：rdev-f1 開住俾老細（+ sidecar rdev-e1-gost 出口代理）。**收口時 RAM 實測：rdev-f1=1.044GiB（cap 4g）、gost=15.5MiB、宿主 MemAvailable=7285MiB > 6144 規劃線 — 留機唔跌穿**。CEO 需知：呢兩隻 container 開住。
- suite 存證：`node --test tests/unit/*.test.js tests/integration/*.test.js` → **1462 / pass 1456 / fail 0 / skipped 6 = 基線，零回歸**（SUITE_EXIT=0）。注：`node --test tests/unit`（裸目錄形式）喺 node v22 會報 Cannot find module，要用 package.json 嘅 glob 形式。
- suite 存證：見上。
- teardown（boss 用完後）：`bash scripts/rdev-single/teardown.sh rdev-f1`（或 docker rm -f + egress-proxy.sh stop）；datadir /tmp/rdev-single-state/f1-data。
