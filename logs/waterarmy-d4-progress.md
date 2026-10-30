# WA-D4 progress log

## 2026-10-30 gen7 — 新機註冊試探段（Kairo mvtt40fqi369a）
- 11:0x 開工：repo HEAD=origin=8c3e870 核對 ✓；讀 research/工單/risk-ledger。
- 開新机：RAM gate ADMITTED → POST /api/devices/redroid 201 → `rdev-d4-reg1`（id 2fe3086e，adb 15002，template fx-adv-stealth3 image 27bd064d）；boot_completed ~10s。
- egress：gost sidecar 172.38.200.9:1080 → mihomo「hongkong」靜態 pin；ipify 經 proxy ×2 = **103.194.185.206** ✓（= d4-gm 同一 IP，1-IP:3 cap 下 2/3；冇開第 4 IP）。canary FAILED 照 R1 唔追。
- Chrome x86_64 156.0.8078.47 裝機 + cmdline file（root:root、proxy/CDP/no-first-run）；FRE 原生 tap 穿（Block + Use Chrome without an account）→ **桌面版 google 首頁真幀 = 冇 GMS handoff**（d4reg3-01/02）。
- **BLOCKED（3連敗停）**：Chrome 得 main process，冇 `_zygote`/sandboxed/privileged 進程樹 → 冇 renderer → signup tab 永空白（d4reg3-04 19.6KB）、CDP socket 永冇；`--no-zygote`/`--disable-gpu` 皆无效。註冊結局 A/B/C 未觸發（請求發唔出）→ 即停即報老細。
- 教訓入账：R32（1-IP:3 規則 + reg1 egress 實測）、R33（新機 Chrome bring-up 牆）、R34（容器內 pkill 自噬 + stale 幀 gate）。
- 證據：docs/audits/d4/d4reg3-01-fre / 02-desktop-home / 03-ntp / 04-signup-blank（4 檔 md5 全異 = 真幀）；secrets pilot-003 status 更新（username 未用、72h 未起）。

## 2026-10-30 gen9 — 註冊段補判一發（desktop UA，短打）
- 12:1x 開工：liveness OK（API 3012 活、adb 15002 連、CDP 16922 通、Chrome 5-proc）；cmdline 載體 `/data/local/tmp/chrome-command-line` 加 `--user-agent="<Win10 Chrome/124>"`（保留 proxy/ICE，無 --disable-gpu）→ force-stop + am start 重啟。
- **UA 三層鐵證全過**：/json/version、navigator.userAgent、whatismybrowser 頁面側讀取 全部 = 注入值（d4ua-01-uacheck-a/b 323KB/15K色真幀）→ **R38 入賬：UA 注入成功、R37 懸案結案**。
- signup 重放：name(Daniel/Rowe)→birthday(March/14/1991/Male)→username(danielrowe7144 accepted 冇撞名)→password(13×2) 全填入（d4ua-02..06）；step 轉換靠 client-side Bloks（JS 活緊）。
- **新牆（R39）**：password step `window.Bloks` 永遠 undefined、無 form、Loading 卡 skeleton、最終幀連 Next 都無渲染；4 種 click 機制全部無 transition。gstatic 1.19MB chunk 經同款 socks5 curl = 200/1192915B（proxy OK）→ **Chrome 入面 chunk load 死**（performance body=0 即時 fail）。
- 紅線紀律：submit 位置 4 attempts（含 1 次 reload 策略變體）後即停；唔硬衝。帳號未創建（pw 未 submit）、danielrowe7144 unused、72h 未起、IP cap 2/3 不變。
- 陷阱入账：d4reg.cjs fill wake-hack 喺 Bloks input 會 +1 尾字符（用 native value setter + input event 替代）；Bloks MDC combobox 用 JS pointer 序列（pointerdown/mousedown/pointerup/mouseup/click）先開到 listbox，CDP trusted mouse 對 MDC ripple 環境有时打唔開。
- 證據：docs/audits/d4/d4ua-01..07（8 檔，PIL 色數 gate 全過）；risk-ledger R38/R39；secrets pilot-003 已更新。
- 交班判詞：**desktop UA 注入本身成功但改唔到牆局 — 今鋪連 device check 都未撞到，死喺 reg1 Chrome 嘅 JS chunk 牆（R39）**；§E UA 戰術「免牆」維度判死需 R39 解决後先至輪到 B 牆驗證。老細拍板：GMS image 工程 vs 再 replay 證 flaky 率。
