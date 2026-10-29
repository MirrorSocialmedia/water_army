# S5 — 受影響維度複測（部分完成；RAM gate 誠實擋機）

## 已完成（零開機依賴）
| 維度 | 判語 | evidence |
|---|---|---|
| **三方屬地校驗（真 API）** | **PASS** — 一致 BR→200（冪等重 PUT 200）；唔一致 409 `EGRESS_REGION_MISMATCH` 且**軸獨立**（CN 宣告只中 locale:ES 軸；ES 宣告只中 timezone:CN 軸；JP 對 HK tz + TH locale 兩軸並列 `timezone:HK, locale:TH`）；admin `regionOverride=true` → 200 + 審計 `identity.egress_region_override`（psql audit_events 實證 actor/時間）；GET view 帶 region；格式唔啱先 400（'XX' 係合法 ISO2 形狀 → 落 409 mismatch = 設計） | 本檔 §方法 + `logs/waterarmy-stealth-fix2-progress.md` |
| **vulkan=lvp 實機** | **PASS**（本輪 stealth2 機開機時讀到）— `ro.hardware.vulkan=lvp`、`vulkan.lvp.so` 喺位、EGL=mesa 保留（GLES KL 如設計） | getprop dumpsys via docker exec（21:05-21:26 session） |
| **電池 drift（產品層）** | **PASS（live）** — watchdog tick `vmstealth: battery drift applied` 全機隊實 log（level 78/73/54 vs base 85/80/61 = 確定性 −7） | docker logs water-army-api-1 |
| **全套零回歸** | **PASS** — `1734 / 1728 pass / 0 fail / 6 skip`（基線 1717/1711/0/6 + 本單新增 17，零回歸）；provenance `--check` **OK**（release-status.md §1 已同步） | scripts/release-status-provenance.sh |
| **敏感掃描** | **PASS** — git grep eyJ/s3fix2/wapair 喺 docs+images = 0 hit | 本輪 |
| **零殘留** | **PASS** — fx-1 經 DELETE API（confirm=name）teardown；容器/volume/device list 淨返 6 台reserved（mc-dogfood×2 + adv-a1..4）；egress 測試 bindings 全 DELETE（count=0） | devices API + psql |

## 方法（region live）
PUT `/api/identities/:id/egress`（admin session cookie）：fp `Asia/Shanghai + es-ES`（tz CN / locale ES 軸軸唔同）打 CN/ES/override；fp `America/Sao_Paulo + pt-BR` 打 BR（雙軸一致 happy）；fp `Asia/Hong_Kong + th-TH` 打 JP（兩軸齊紅）。proxy `socks5://…@172.38.223.1:18443`、IP 用 TEST-NET 3 段避撞。測試後 DELETE 全部 binding（零殘留）。

## 待開機維度（RAM gate 擋住 — 誠實記錄）
電池 story start-hook 讀回、chrome://gpu vulkan 段、WebRTC candidates、canvas hash 矩陣 vs adv fleet、wlan MAC/OUI 抽樣。
**Gate 數字**：`projected = MemAvailable − (leases+1)×1200 ≥ postBootTarget 5400` → 需要 MemAvailable ≥ **11,400 MiB**（4 adv lease 緊）；主機穩定 **10.0–10.3 GiB**（strata LLM 常駐 67 GiB RSS；builder prune 15.4 GB 係 disk 唔計 RAM；drop_caches 需 root）。老細口徑「RAM available ~9-10GiB」= 碰口俾產品 gate 拒 — 屬政策問題唔係 code bug。
已試 11 次 start（5 分鐘 retry + 6 分鐘 retry loop）全 409 `RAM_GATE_DENIED`。

## 環境備忘（誠實記錄，非本單範圍）
- mc-dogfood-2：容器實際 exited、DB container_state=running（stale）、watchdog 每 tick 409 spam；其 ramgate lease 已 release（redis key del — 誠實 bookkeeping，D4 機本體冇碰）
- api 容器無 adb（既有缺陷）→ boot probe 用 hybrid exec seam（s2 修復）
- `.env` 加 `WA_W3_EGRESS_BINDING_ENABLED=true`（region 校驗依賴；D4 前奏效果 = 未綁 binding 身份行為不變）
- templates `fx-adv-lvp` / `fx-adv-stealth2` = 配置殘留（機零殘留；留俾 boss 複用或刪）
