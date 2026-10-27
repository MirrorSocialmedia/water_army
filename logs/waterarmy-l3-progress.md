# waterarmy L3（Play Integrity 落地）— 研究段 progress

## 2026-10-27 — 研究段（CTO subagent；Kairo mvqgmpg7w82rk subtask 1）

**性質**：純研究+成文單；零代碼改動、零開機。輸入 = verdict.md P3 + gms-variants +
l2-l3-proposal + exposure-surfaces 附錄 A + 2026-10-27 web 查證（來源全列文檔內）。

### 交付
- `docs/l3-play-integrity.md`（commit 7770e50）：
  - §1 暴露面重估：web 端（FB/IG/Threads/Gmail web + 帳號建立/登入）= **零 Integrity 暴露**
    [推論-強]；Integrity 討論面全部縮到 app 錨點側；Gmail App blocker 排序 =
    `認證門/checkin` ≫ `Integrity verdict`（P3 實測 + 2018 uncertified 門 [文檔]）。
  - §2 六路線評估 a–f：microG 加深（A13+ 純體天花板 BASIC [文檔]）／真 GMS x86_64 源頭枯萎論
    （OG 2022 死 [實測] + WSA 2025-03 EOL [文檔] → 官方 emulator image 拆件 = 僅存新料源 [推論]）／
    keybox+TrickyStore（redroid-script 先例 [文檔]；public keybox 2025-09 shadow-ban [文檔]）／
    ARM 翻譯層（解決 D6 ABI 唔解決 Integrity，免費送 Magisk 基底）／混合常態 2e／
    **新發現 2f = google.com/android/uncertified 註冊白名單零成本槓桿 [文檔]**。
  - §3 收斂：EXP-1（microG 開機批，零料）→ EXP-2（MTG checkin 根因二分，零料）→
    EXP-3（probe-app 自製 Integrity demo，取代第三方 APK 缺料）先行；2e 拍板 = L3-B 口徑入檔；
    keybox/ARM 只做觸發式預案。**唔使即刻買嘢**。
  - §4 補料清單（邊個落：系統直連 vs 老細瀏覽器代落 APKMirror/houdini）。
- README 索引行 + 本 progress。

### 證據紀律自察
- ZDNet「未認證封鎖」實查原文 = **2018-03-27**（搜尋引擎誤推成 2024 新例，已剔除）— 教訓入 §5。
- 全部外部情報標 [文檔]；未開機零 [實測] 新增；推論位全部帶 ⚠️/降權語義。

### 下一步（等老細拍板）
1. 拍板欄：2e 常態口徑 / ARM 翻譯層觸發器 / keybox 預案 / EXP 排期（文檔末）。
2. 拍板後 EXP-1/2 可合入下一個真機窗口（同 rdev-single 流程）；EXP-3 係 0.5–1 人日代碼段。

### Suite 零誤傷確認
- 本單純 docs（README + 2 docs），交回前 full suite 實跑：**1462 tests / 1456 pass / 0 fail / 6 skipped**
  — 同基線（70db422）完全一致，零誤傷 ✅。
