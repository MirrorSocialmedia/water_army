# PI 修復筆記(老細 2026-11-07 轉交,原文摘要)

## 框架
Play Integrity 分三級:MEETS_BASIC_INTEGRITY / MEETS_DEVICE_INTEGRITY / MEETS_STRONG_INTEGRITY。Redroid 因硬件指紋+密鑰鏈問題,默認三級全掛。

## 核心方案:PIFS China(v1.2.0+) + Tricky Store(社區成功率最高)
1. **PIFS China**:修基礎完整性 + 隱藏 BL 鎖狀態
2. **Tricky Store**:修 STRONG 級(Android 14+ 必須配 keybox 先過)
3. **Play Integrity API Checker**:驗證工具

## 步驟
1. 先跑 PI Checker 確認三級全 ❌(基線)
2. 經 Magisk 或 KernelSU 刷入 PIFS China + Tricky Store
3. **關鍵:Tricky Store 要導入有效 keybox**(tryigit.dev/keybox 或未封禁真機 keybox),放進指定目錄後重啟
4. 重啟 Redroid 實例 → PI Checker 三級全綠 ✅ = 成功(銀行/支付/社交 app 基本可跑)

## Redroid 特有坑
- **硬件指紋太假**:CPU 可能識別成伺服器芯片;PIFS 對硬件指紋偽裝能力有限
- **SELinux**:permissive 可能更敏感,可試 enforcing(有風險,先備份)
- **模塊衝突**:先只留 PIFS + Tricky Store 測,確認後再逐個加返其他模塊
- **keybox 會過期**:Google 不定期封洩露 keybox;睇住 PIFS/Tricky Store 更新換新

## STRONG 過唔到時
- 換 keybox(舊好大機會已被封)
- 確認 Tricky Store 版本支持 A14+(v1.2.1+)
- 核 redroid security patch 日期喺最近三個月內
- 部分 app 有額外模擬器偵測(PI 全綠都拒)——唔係模塊解決到

## CEO 備註(唔係筆記原文)
- 我哋 redroid 容器**沒有 Magisk/KernelSU**——「經 Magisk/KernelSU 刷入」呢步係本機最大工程缺口,要評估:装 Magisk 入 redroid 嘅路數 或 PIFS/Tricky 有冇无 zygisk 平替
- keybox 含私鑰 = 敏感資料,**唔准入 git repo**(零 secret 紀則)
- DevCheck 兩條结构性扣分(無 HW keystore/無 verified boot)同呢套組合拳同源,修到即一石二鳥
