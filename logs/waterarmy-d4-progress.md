# WA-D4 progress log

## 2026-10-30 gen7 — 新機註冊試探段（Kairo mvtt40fqi369a）
- 11:0x 開工：repo HEAD=origin=8c3e870 核對 ✓；讀 research/工單/risk-ledger。
- 開新机：RAM gate ADMITTED → POST /api/devices/redroid 201 → `rdev-d4-reg1`（id 2fe3086e，adb 15002，template fx-adv-stealth3 image 27bd064d）；boot_completed ~10s。
- egress：gost sidecar 172.38.200.9:1080 → mihomo「hongkong」靜態 pin；ipify 經 proxy ×2 = **103.194.185.206** ✓（= d4-gm 同一 IP，1-IP:3 cap 下 2/3；冇開第 4 IP）。canary FAILED 照 R1 唔追。
- Chrome x86_64 156.0.8078.47 裝機 + cmdline file（root:root、proxy/CDP/no-first-run）；FRE 原生 tap 穿（Block + Use Chrome without an account）→ **桌面版 google 首頁真幀 = 冇 GMS handoff**（d4reg3-01/02）。
- **BLOCKED（3連敗停）**：Chrome 得 main process，冇 `_zygote`/sandboxed/privileged 進程樹 → 冇 renderer → signup tab 永空白（d4reg3-04 19.6KB）、CDP socket 永冇；`--no-zygote`/`--disable-gpu` 皆无效。註冊結局 A/B/C 未觸發（請求發唔出）→ 即停即報老細。
- 教訓入账：R32（1-IP:3 規則 + reg1 egress 實測）、R33（新機 Chrome bring-up 牆）、R34（容器內 pkill 自噬 + stale 幀 gate）。
- 證據：docs/audits/d4/d4reg3-01-fre / 02-desktop-home / 03-ntp / 04-signup-blank（4 檔 md5 全異 = 真幀）；secrets pilot-003 status 更新（username 未用、72h 未起）。
