# EXP-2b — 出口修復 + checkin 重戰 verdict（rdev-e1, gms-mtg）2026-10-27

## 一句結論

**Checkin Succeeded + android_id = `3916878313160989068`（非零）到手。**
EXP-2 嘅「egress timeout」根因 = **國內網絡去 Google 必須經代理**（上游對 Google DC 段黑洞），
**非容器 NAT bug、非伺服器認證面問題**。出口經 scratch gost sidecar → 用戶 mihomo 後，
GMS 22.21.16 legacy checkin 自動 reason-1 POST **0.47s 內 2xx 成功**，deviceDataVersionInfo 獲派發。
「認證面 403 拒」假設死亡；白名單（google.com/android/uncertified）可即刻用上面 AID 註冊。

## 代理口徑（本宿主）

- 用戶代理：**mihomo（Clash Verge）HTTP CONNECT `127.0.0.1:7897`**（僅綁 loopback；`env` 內 `https_proxy` 即佢）
- 早前「宿主直連 checkin=400 通」= 經此代理嘅 400，**非直連**（直連 host 自己都 8s timeout）
- 容器路徑：`settings put global http_proxy 172.38.223.1:18443` → **gost sidecar**（`scripts/rdev-single/egress-proxy.sh`，
  只綁 scratch bridge GW，chain → 127.0.0.1:7897）→ mihomo → Google。用戶 mihomo 配置零改動。
- **生產含義：W3 出口代理綁定 = 硬性必須（非設計選項）**。無代理 = GMS checkin/register/phenotype 永遠斷鏈。

## 三輪記錄（判據：任何 HTTP 回應 = 出到機）

| 輪 | 時間 (UTC) | 狀態 | 證據 |
|---|---|---|---|
| R0 對照（pre-proxy） | 14:05:39→14:10:40 | reason-1 POST 直連 172.217.116.4:443 → **SocketTimeout 30s**（EXP-2 現象重現） | p5-e1b logcat 段（`W Checkin ... SocketTimeoutException`） |
| R1（proxy 持久後首 boot） | ~14:21–14:23 | **SUCCESS**（checkin_id_token 文件 mtime 14:21 = 首成功） | p10-checkin-id-token.txt |
| R2/R3（cold docker-restart，proxy 開機即生效） | 14:27:42.987→43.453 / 14:27:43.608→44.021 | **Checkin Succeeded (fragment #1) ×2**，466ms/413ms；`updateCheckinIdTokenFileFromResponse, Reading existing AID`；Operation result: **SUCCESS** | p10-clean-reason1.txt |

## AID / token 記錄

- `checkin_id_token` 文件 = `3916878313160989068:8487914254589617212`（AID:security_token；**token 屬敏感**，本檔僅供老細白名單註冊用）
- `Checkin.xml`（gms shared_prefs）：`android_id=3916878313160989068`、`CheckinService_versionInfo` + `deviceDataVersionInfo` 俱在 = 伺服器已登記此設備
- **MTG 特性注意**：android_id 唔會入 gsf `googlesettings.db` 嘅 `android_id` 表（MTG gsf 係 stub，表從未建立）；
  gservices provider dump = `No result found`、`overrides` 表空 — 對 MTG 變體**唔應該以 gsf db 作為 checkin 成功判據**，
  要睇 `files/checkin_id_token` + `shared_prefs/Checkin.xml`（EXP-2 p1/p2/p3 判讀需留意此點，但佢個 egress timeout 結論本身獨立成立）。
- framework `settings secure android_id`（d6cd44…）= Android 自生，同 GMS checkin AID 唔同源（EXP-2 已記錄）。

## 鑑別附錄（why not NAT/MTU）

見 `diagnosis.md`（證據矩陣：58.254:443 機內 OPEN、DF 1450B 到 8.8.8.8 過、142.250 段 ICMP+80+443 全黑、host 直連同黑）。
generate_204 三口徑對照 = `generate204-proof.txt`（direct 000 timeout / mihomo 204 / gost chain 204）。

## 意外發現（記錄用）

1. **gen-cmd ro overrides 影響 GMS legacy checkin 排程**：e1（gen-cmd 17 args）兩隻 boot 都無 reason-1 POST；
   e1b（image 默認 CMD，c1 同款「零 override」）boot+68s 必 fired reason-1。用家自訂指紋投產時需實測 checkin 會唔會自動觸發。
2. redroid 入面 `reboot` = container exit 129（要 `docker start`）；`docker restart` 先係正常冷啟動路徑。
3. 手動 poke `am start-foreground-service com.google.android.gms/.checkin.CheckinService` 會 FGS timeout crash
   （ForegroundServiceDidNotStartInTimeException）→ 唔好亂 poke，等 natural reason-1。

## Teardown

rdev-e1 + rdev-e1-gost 拆除、datadir 清空（宿主 iptables 本單零改動 — 全部規則由 docker network 自管）。
