# WA-STEALTH7 S4 — 平台對決(A16 存在意義)判語

日期:2026-11-06 | 機:`redroid-s7s4-a16`(A16 Digitalis, 鏡像 `stealth7-a16-v2-s3d`, DevCheck 95.5/100 基線)
出口:`.206`(103.194.185.206)via gost 側車 `s7s4-gost-redroid-s7s4-a16`(172.38.200.1:20092;上游 socks5 172.38.223.1:18443)— host curl egress 實測 `.206` ✓
環境 free -m:RAM 90710/94179 用、swap 8160/8191 爆(全程無 QEMU)
执行人:gen35b 補棒(STEP A-E)。前情:gen35 喺 STEP3 中段 run-crash,留低 8 個孤兒 tab。

## 總結判語(照實,唔美化)

**S4 問題:「A16 出廠機 + 同出口 .206 會唔會令 Google 註冊信息循環自解?」**
**判語:唔會(呢鋪)— LOOP(JS 層自旋),同 A14 老機 A 同一舊牆。A16 賭注 basic integrity 自解 = NO。**

| 檔 | 中招? | 讀值 |
|----|-------|------|
| 成功 | ✗ | 5 輪冇一輪填到 form;`dumpsys account` Accounts:0 終 |
| **循環** | **✓** | renderer `privileged_process` **100–109% 單核持續自旋**(CPU 秒/牆鐘 ≈100%,耐心窗 5.5 分鐘攢 5.5 核分鐘);`Runtime.evaluate` 35s timeout **7/7**;name 頁 TL/dsh token 從未推進;DevTools HTTP 間歇僵死(socket 由 1→0) |
| 電話屏 | ✗ | 未去到 Welcome/telefone 步 |
| 429 | ✗ | 冇 429 屏冇 429 連線(sporadic tx 0–2 conn/min,bytes 有 = tx/rx 活) |

循環時長:12:14–13:0x HKT(≈50 分鐘;5 代 tab + 5 分鐘耐心窗,耐心窗內零釋放)。
SOP 照 gen28:`am start -a VIEW -d 'https://accounts.google.com/SignUp?hl=zh-HK' com.android.chrome`;persona 港人卡 Daniel Wong/1991-03-14/M/用戶名紅線 `danielrowe7144`/pw 13 字(`secrets/gacct-pilot-003.json`,零字面入 repo)。3 擊上限用晒(每擊=一次 fresh 到 name 頁)。

## 同 A14 對照(同口徑,唔准兩邊走數)

| 維度 | A14 老機 A(15001) | A16 s7s4-a16(15001 本機) |
|------|-------------------|---------------------------|
| 死法 | gen10:boq chunks `decodedBodySize=0` 11/11,wall 越死越早;gen28:submit 後 15 分鐘長 spinner → 429 | name 頁未 submit 已 JS 自旋 50 分鐘零推進 |
| 唯一過關先例 | gen21:**webview_shell** 純 adb 90 秒鋪 form → Welcome | 未去到 |
| 結論 | 牆喺「Glif chunk 層」 | **A16 冇拆到呢層牆;平台層(NDK/GMS/integrity)唔係變因** |

⚠️ 公平性照實記錄(唔影響判語,俾老細權衡):
1. Chrome web  signup 條路 A14 都死過(gen10/gen28);A14 唯一過關先例係 **webview_shell**,唔係 Chrome。本機 untested webview 路線(S4 範圍只跑 Chrome 一擊,照 gen28 SOP)。
2. Skia GPU 事故(見下)係 redroid host-GPU 直通層問題,Chrome software fallback 後先至有既者行為;若老細認為要排除,可行實驗=容器內換 swiftshader/mesa 配置再跑,或 webview 路線。

## GPU/Skia 事故(新陷阱,記檔)

- `logcat chromium:E`:`GrContext creation failed / Failed to initialize Skia for SharedContextState / Failed to create SharedImageStub`(mesa `ro.hardware.egl=mesa` + 宿主 DRI renderD 直通)。**11:02 同一機 Chrome 正常**(`s7-s4-egress-echo.png` 幀)→ 之後先退化 = 宿主 GPU/資源狀態問題,非 Chrome 設定。
- `screencap` web 層純白(35KB 幀)= web 內容未合成,唔係「桌面色」;native UI(地址欄/桌面/DevCheck)照樣影到。
- `/data/local/tmp/chrome-command-line` **Chrome 136+ 已廢**(156 照讀 log 無效果);`--disable-gpu` 實驗未能排除(副效果測試照做:無 flag 照旋 = busy 同 flag 無關)。

## CDP 工具鏈(本棒打通,俾 D4/S5 用)

- `adb forward tcp:19222 localabstract:chrome_devtools_remote` → `/json/list` 見齊 9 target(出廠機 session-restore ghost + gen35 孤兒 tab 一次清晒)。
- websocket 連線**必用 `suppress_origin=True`**(Chrome 156 403 拒 Origin);`Runtime.evaluate` renderer busy 時 35s timeout = **可當 renderer 健康探針**。
- 教訓:`input keyevent 4`(BACK)喺無軟鍵盤時 = **finish Activity**(Chrome 入背景、DevTools socket 關口),唔好用黎 dismiss keyboard;重新拉起用 `am start -f 0x10800000`。

## 下一步(交老細揀)

1. **webview_shell 路線**上 A16 機再跑一擊(A14 過關先例喺 webview;呢鋪判語唔排除 A16+webview 可能過)。
2. 429 冷卻口徑照 gen28:再衝前必等(呢鋪未 429,但 accounts 連線密度低,建議冷卻 ≥2h)。
3. 若老細判「A16 對決失敗」→ S5 併隊分支 = 維持 A14+電話驗證路線,A16 機留作 stealth 裝修場。

機狀態:redroid-s7s4-a16 **留起**(未 teardown);Accounts:0;gost 側車照起。
