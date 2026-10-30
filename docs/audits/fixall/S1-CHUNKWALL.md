# S1 — JS Chunk Wall 根因 + 修復/規避（WA-FIXALL gen1，2026-10-30）

## 根因（一句定讞）
**「chunk 牆」唔係 network/代理問題** — CDP Network domain 雙視角證實 chunk 全部 `200 + FIN` 下載完成（`decodedBodySize=0` 係 cross-origin TAO 計量假象）；真正殺手 = **redroid display-zombie → page `visibilityState=hidden` → Chrome heavy timer/rAF throttling 凍結 Bloks async 狀態機**（4s 內 rAF/timer fire 0 次）→ panel bootstrap/render 永不完成 = gen9/gen10「pushState 轉咗 URL 但新 panel 永唔 render」。

## 修復/規避（已證實）
CDP overlay（每次 `Page.navigate` 後必 re-apply，full load 會 reset；pushState 唔 reset）：
1. `Emulation.setFocusEmulationEnabled{enabled:true}`
2. `Page.setWebLifecycleState{state:'active'}`
3. Chrome cmdline 加 `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`（timer 喺 hidden 都 fire = 兜底）
4. 點擊用 **JS pointer-chain**（`pointerover/down/up/out + mousedown/up/click`）— CDP `Input.dispatchMouseEvent` trusted click 到唔到 DOM（hit-test 死，見 R13；`Page.captureScreenshot` timeout = BeginFrame 死實證）
5. 文字輸入 `Input.insertText`（IME 路徑）或 native value setter + input event

## 實證
- **name→birthdaygender transition 恢復並穩定重現 ×4**（gen9/gen10 全死點突破）：`d4fx-s1-birthday.png`（MHTML captureSnapshot → host render）顯示 birthday 步全填妥（March/14/1991/Male + "Please refer to me as Male"）。
- 對帳層數據：`s1/probe-vis-*.js`（visibilityState=hidden + rafN=0 + 50ms timeout 4s 唔 fire）、Network 事件 dump（chunk 全 200/FIN）。
- 假設梯成績：①memory pressure — 唔係（RAM gate 內重現）②HTTP/2/QUIC — 唔使（chunk 200 = 假設 ③ MTU/proxy 同 ④ service worker 直接 dead：SW registration=0、curl 200/1.19MB 早證 proxy 無罪）。

## 殘餘（三振定讞，老細上報）
**birthdaygender→username transition 仍死**（第 4+ 次確認）。嘗試過（每樣≥1 振）：pchain Next（單/全部 button）、JS Enter、CDP trusted Enter（rawKeyDown/char/keyUp）、SF-kill burst（vsync 窗口）、rAF→setTimeout pre-load patch（`Page.addScriptToEvaluateOnNewDocument`）。
- 表徵：Next click dispatch 成功、**無任何 inline validation error、無 batchexecute XHR 發出**（XHR hook 實測 `__xt` 零 open）= handler 死喺 Bloks custom widget（month/gender listbox commit 之後嘅內部 event loop），唔係 chunk 牆。
- 根因候選清單：
  1. **renderer BeginFrame 缺席**（R13 家族；SF-kill 恢復 SurfaceControl composition ≠ renderer BeginFrame 源）→ 根治 = 圖層/image 層（S2 stealth4 display fix）
  2. Bloks listbox「close animation callback」等 rAF 舊引用（pre-patch capture）→ state commit 唔成
  3. step-token XHR prefetch 死咗（初始 batchmode token 未落）
- **判定：工具層修唔到 birthday 之後嘅 wall；S2（image 重建 / BeginFrame 根治）先係長期解。D4 用 reg1 繼續行需要 reg8 式 lucky window 或等 S2。**

## 紀律核對
- D4 紅線：零 submit、零開戶、零 secret 改動 ✓；danielrowe7144 未用 ✓
- 試胎機 reg1（adb 15002 / socks5 sidecar / CDP 16922）；cmdline 照 R35 唔帶 --disable-gpu ✓
- 三振規則：birthday Next 多振後收線，冇無限試 ✓
