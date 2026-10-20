# R2 — TCP Transport 分層診斷（gVisor/TUN data plane）

- **Ticket**: water_army 修復 R2 = Phase 2（Kairo `mvfhu8i2y4a55` / subtask `mvfhu8i2q3r58`）
- **日期**: 2026-10-19/20（HKT）
- **環境**: 真 Redroid spike `redroid-matrix-r2-spike`（R1 image `water-army/redroid:14.0.0-240527-matrixa-r1`，ADB 127.0.0.1:16002，device 172.17.0.3）；tun2socks **v2.7.0**（sha256 pin `98d545a6…` 核過，root 運行）；mock 全 host 側自建有端口（echo 20271 / socks5 20082,20083,20084,20085）
- **方法**: MD §4.3 八層，每層只改一個變量；provision 用**生產 script bytes**（`redroid-service.js` builder，root 經 `docker exec`）；每項標 PASS/FAIL/SKIPPED/BLOCKED
- **证据位置**: **`docs/audits/r2-evidence/`**（repo 內，raw 片段 + mock 流水 + captures；原始 log 在 `/tmp/r2-net/`）+ 本文內嵌關鍵片段

## 0. 一句話結論

**故障層 = gVisor（tun2socks v2.7.0 內置 netstack）TCP proxy 嘅 device→proxy（forward）方向**：SYN/ACK/SOCKS5 CONNECT 全部完成之後，gVisor 停止消費/ACK device 方向嘅 data（**request data 根本未過 TUN** — device kernel 喺 send queue 擱住；TUN RX 淨係 SYN + control packet，零 errors/dropped），SOCKS relay 側 `bytesIn=0`；proxy→device（return）方向正常（Node 60s headersTimeout 自動 408，49B 完整落返 device）。零 partial forward（1KB→1MB 四檔實測）；`--tcp-auto-tuning` 開/關 A/B 零狀態差異；re-provision 冇救（L6h/L8c）。**DNS/UDP 路徑完全正常（L8a PASS，Android 自身 connectivity check 都經 tunnel UDP 通）** — 問題精確定位喺 netstack 嘅 **TCP forward data path 狀態機**，唔係 DNS、路由、MTU、mock、測試方法、buffer tuning。

## 1. 測試端點（自有、可重現）

| 端點 | 埠 | 用途 |
|---|---|---|
| `mock-echo.js`（POST/GET `/echo`，回 nonce+bytes+sha256 確定性 body） | 20271 | 雙向 payload 驗收 |
| `mock-socks5.js --relay 127.0.0.1:20271` | 20082 | 主 tunnel 上游（CONNECT relay + UDP ASSOCIATE DNS canary） |
| `mock-socks5.js --reject` | 20083 | proxy 拒絕 CONNECT（rep=5） |
| `mock-echo.js --hang` + `mock-socks5.js --relay …:20273` | 20273/20084 | server 永不回應（timeout 行為） |
| `mock-echo.js --rst` + `mock-socks5.js --relay …:20274` | 20274/20085 | server 收 data 後 RST |

- Canary IP `93.184.216.34`（R0 同款）：只可以經 tun0 → t2s → mock 到达；DNS canary = `canary.example` A query，mock 唯一來源答 `5d b8 d8 22`
- 所有 mock log 行：endpoint/時間/from(device ip:port)/bytes/nonce/sha256/錯誤碼 — 見 `r2-evidence/mocks/*.jsonl`

## 2. 最終測試總表

| # | 測試 | 判定 | 關鍵證據（r2-evidence/） |
|---|---|---|---|
| L1a | host→echo direct | **PASS** | 1KB POST sha+body exact（`l1a-host-direct.txt`） |
| L1b | device→echo direct（無 tunnel） | **PASS** | `RC=ok SENT=655 RECV=264`，body exact（`l1b-device-direct.txt`） |
| L2 | TUN interface | **PASS** | tun0 UP/MTU1500/peer；table100 + rule5000 + gateway 例外；`route get 8.8.8.8` via tun0（`l2-tun-interface.txt`） |
| L3 | Tunnel process | **PASS** | 單 process root；`tun2socks-2.7.0`；debug log 零 per-connection 行（`l3-tunnel-process.txt`） |
| L4 | SOCKS5 transport | **FAIL** | CONNECT 有 log；**mock bytesIn=0**；probe read-timeout；408 49B 落 device（`l4-socks5-transport.txt`） |
| L5a/b/c | bidir 1KB settle0 / 1KB settle1000 / 8KB | **FAIL ×3** | 同一形狀 — 排除 timing 假說（`l5*.txt`） |
| L6a | 多循序（×3） | **FAIL** | 3/3 read-timeout RECV=0（`l6a-sequential3.txt`） |
| L6b | 有限並行（×3） | **FAIL** | 3/3 read-timeout；close 時 2 flow 同毫秒 flush 663B（`l6b-parallel3.txt`） |
| L6c | half-close（8341B） | **FAIL** | RECV=0（`l6c-halfclose.txt`） |
| L6d | clean close | **FAIL** | RECV=0；**teardown flush 663B×2 同毫秒**（`l6d-clean-close.txt`） |
| L6e | timeout（hang relay） | **FAIL** | forward 死與上游行為無關（`l6e-timeout.txt`） |
| L6f | RST（rst relay） | **FAIL** | RECV=0（`l6f-rst.txt`） |
| L6g | proxy 拒絕 CONNECT | **PASS** | reject 2ms 傳到 device（`read-error … reset by peer`）— 控制平面通（`l6g-proxy-reject.txt`） |
| L6h | 恢復（re-provision） | **FAIL** | re-provision 後同款 read-timeout — 重啟 t2s 冇救（`l6h-recovery.txt`） |
| L7-1KB | large payload 1181B | **FAIL** | RECV=0/60s；TUN dRx=112B/2pkt, dTx=1397B/4pkt（`l7-1024.txt`） |
| L7-16KB | large payload 16544B | **FAIL** | RECV=0；dRx=164B/3pkt, dTx=17332B/15pkt（`l7-16384.txt`） |
| L7-64KB | large payload 65696B | **FAIL** | RECV=0；dRx=216B/4pkt, dTx=68252B/49pkt（`l7-65536.txt`） |
| L7-1MB | large payload 1048742B | **FAIL** | RECV=0；dRx=3138B/59pkt, dTx=544014B/378pkt（`l7-1048576.txt`） |
| L8a | DNS canary via tunnel（UDP ASSOCIATE） | **PASS** | `12 34 81 80 … 5d b8 d8 22`（NOERROR + A=93.184.216.34）<1s；mock 見 47 筆 UDP DNS 流水（`l8-dns-canary.txt`） |
| L8b | TCP connect + bidir + close | **FAIL** | 同 L4 形狀（`l8-run.log`） |
| L8c | kill→fail-open→re-provision→payload | **FAIL** | kill 後 `route get 8.8.8.8 = via 172.17.0.1 dev eth0`（**fail-open 實錚**）；re-provision 成功；payload 仍死 — 故障跟 t2s process 無關層面（`l8-run.log`） |
| TUNA | `--tcp-auto-tuning` OFF（default）1KB | **FAIL** | read-timeout；TUN rx 112B/2pkt, tx 1583B/8pkt（`tuning-a-off.txt`） |
| TUNB | `--tcp-auto-tuning` ON 1KB | **FAIL** | read-timeout；TUN rx 112B/2pkt, tx **1584**B/8pkt — **與 OFF byte 級一致**（`tuning-b-on.txt`） |
| TUNC | restore default after B | **PASS**（provision 契約） | argv 無 flag；probe 同款死（`tuning-restore.txt`） |
| RDa | REDIRECT baseline（只讀） | **PASS** | teardown 後 tun0 消失；`iptables v1.8.7 (legacy)`（`rd-a-baseline.txt`） |
| RDc | 容器內 nat OUTPUT REDIRECT 實測 | **BLOCKED** | 雙牆：① `Table does not exist (do you need to insmod?)`（iptable_nat 未載入，容器無 /lib/modules）② `unknown option "--to-ports"`（Android netd iptables build 未編 xt_REDIRECT）（`rd-run2.log`） |

## 3. 逐層證據

### L1 — Baseline direct（PASS）

- **L1a**（host→echo，無 device）：1KB 隨機 body，mock 回 `MOCK-ECHO-1` + nonce/bytes/sha256，**sha 同 body 雙端 exact match**（evidence `l1a-host-direct.txt`）
- **L1b**（device→172.17.0.1:20271，**無 tunnel**，probe 直打）：`RC=ok SENT=655 RECV=264 T_CONN_MS=0 T_TOTAL_MS=0`，response body exact（evidence `l1b-device-direct.txt`）
- **推論**：echo endpoint、host bridge 路徑、**device kernel TCP 全雙工**全部正常。任何後段 FAIL 都唔屬於呢三層。

### L2 — TUN interface（PASS）

原始輸出（evidence `l2-tun-interface.txt`，節選）：

```
tun0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 ...
inet 10.8.0.1 peer 10.8.0.2/32 scope global tun0
== ip route show table 100 ==
default via 10.8.0.2 dev tun0 onlink
172.17.0.1 dev eth0 scope link
5000:	from all lookup 100
== ip route get 8.8.8.8 ==
8.8.8.8 via 10.8.0.2 dev tun0 table 100 src 10.8.0.1 uid 0
```

- 介面 UP/LOWER_UP、MTU 1500、地址 peer 對、路由表 100 + rule 5000 生效、gateway 例外（172.17.0.1 行 eth0 — 防 loopback 回 tunnel）全部正確
- **MTU 假說排除**：MTU 1500 兩端一致（eth0/bridge 亦 1500），L1b 直打同尺寸 traffic 無 problem；若係 MTU/fragment 問題，直打會先壞

### L3 — Tunnel process（PASS）

```
root  2414  1 0 20:17:59 ?  tun2socks --device tun0 --proxy socks5://172.17.0.1:20082 --loglevel debug
```

- `--version` = `tun2socks-2.7.0`（與 R1 sha256 pin 一致）；運行 = 生產命令形狀；runRc=0
- t2s `--loglevel debug` 都只有 `[STACK] tun0 <-> socks5://172.17.0.1:20082` 一類行 — **engine 層零 per-connection/per-packet log**。呢點本身係一個發現：data-plane 診斷只能靠 TUN counter + 外部 mock log + probe
- 可調面（`--help`）：`--mtu`、`--tcp-rcvbuf`、`--tcp-sndbuf`、`--tcp-auto-tuning`（**default=false** — 源碼實錚：t2s v2.7.0 `main.go` `flag.BoolVar(&key.TCPModerateReceiveBuffer, "tcp-auto-tuning", false, …)`；`engine.go` 開咗先 append `option.WithTCPModerateReceiveBuffer(true)` → gVisor TCP moderate receive-buffer auto-tuning）、`--fwmark`、`--interface`

### L4/L5 — SOCKS5 transport + 雙向 payload（全 FAIL — 定性核心）

四條 flow（L4 1KB / L5a 1KB settle=0 / L5b 1KB settle=1000 / L5c 8KB）**完全同一形狀**，以 L4（nonce `r2-l4-27132`）為例：

**（a）mock 側（最後一跳之前）** — `r2-evidence/mocks/socks5.jsonl`：
```
{"ts":"2026-10-19T20:18:47.155Z","t":"tcp-connect","dest":"93.184.216.34:20271","from":"172.17.0.3:52470"}
{"ts":"2026-10-19T20:19:54.179Z","t":"tcp-close","dest":"93.184.216.34:20271","from":"172.17.0.3:52470","bytesIn":0,"bytesOut":51,"why":"upstream-close"}
```
→ gVisor 見 device SYN 後**確實 dial 咗 SOCKS5 CONNECT 並完成**（對端有 socket）；但 **`bytesIn=0`：device 發嘅 1171B HTTP request 一個字節都冇到達 relay**；flow 生命週期 **60.0s**（= Node headersTimeout），close reason = `upstream-close`。

**（b）echo 側**：`r2-evidence/mocks/echo.jsonl` 零 tunnel request（最後一筆 = L1b 直打）— request 從未到达最尾端。

**（c）device 側（probe）**：`RC=read-timeout SENT=1171 RECV=49 …`，capture 出 49 字節 =
```
TP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n
```
即 Node 自動 **408 headersTimeout 回應（全長 51B，leading 2B 喺 close race 丢咗）** 經 relay→gVisor→device **完整落返 device**。

**（d）TUN counter 語義（kernel source 定論，Linux v6.8 `drivers/net/tun.c`）**：

- `dev_sw_netstats_rx_add()` 喺 `tun_get_user()`（line ~2016）= **userspace 由 TUN fd 讀取** = **device kernel → gVisor 方向**
- `dev_sw_netstats_tx_add()` 喺 `tun_put_user()`（line ~2176）= **userspace 寫入 TUN fd** = **gVisor → device kernel 方向**

**（e）TUN counter 實測（gen2 修訂 gen1 解讀 — 重要）**：

L7 四檔 dRx（device→gVisor 方向）全部係**微少嘅 ~53–56B/pkt 小包**（1KB flow: 112B/2pkt；16KB: 164B/3pkt；64KB: 216B/4pkt；1MB: 3138B/59pkt）— 呢個尺寸 = 純 TCP control packet（SYN/ACK/window-probe + timestamps）。**request data 一個 segment 都冇過 TUN** — device kernel 喺 send queue 攞住全部 data（無 ACK / window 0 → 唔會再發）。errors/dropped/overrun 全 0。

→ **修訂 gen1 嘅「kernel 無限重傳入 TUN」解讀**：TUN RX 跨 flow 增長（1437→1746B）= 4 flow 嘅 SYN + control packet 累積，**唔係 data retransmission**。device kernel 從來冇重傳 data 入 TUN（重傳先要有咁 send 咗先有得重傳 — 佢連頭一個 data segment 都未送出）。故障點比 gen1 定性**更前**：gVisor 連 SYN-ACK 之後嘅 data 消費/ACK 都冇做（或者 advertise 咗 window 0），device kernel TCP 層自衛性地 hold 住 data。

**定性（每條邊界都有證據）**：

| 邊界 | 狀態 | 證據 |
|---|---|---|
| device kernel → tun0（data） | ❌ **data 未出 queue**（只 SYN + control 出） | TUN RX dRx = 純 control 包尺寸；errors 0 |
| gVisor 收 TUN data → ACK 返 device | ❌ **死**（零 ACK → kernel hold data） | L1b 直打對照（同 kernel 同 TCP stack，直打無此現象）+ TUN 無 data 段 |
| gVisor → SOCKS5 relay forward | ❌ **死**（bytesIn=0） | mock jsonl 逐 flow |
| device SYN → gVisor → relay CONNECT | ✅ 通 | tcp-connect 有 log（200 OK） |
| relay → gVisor → device（return） | ✅ 通（49/51B 408 落 device；UDP DNS 回應 <1s 落 device） | probe capture + L8a |
| 上游 reject（控制平面） | ✅ 通（2ms） | L6g |

→ **gVisor netstack TCP proxy 喺 handshake/CONNECT 完成之後，停止消費/ACK device→proxy 方向嘅 data segment**（device kernel 因無 ACK hold 住 data；零 forward 落 relay），return 方向正常。settle=1000ms 無改善（L5b）→ 唔係 timing；全部 flow 100% 重現（L4/L5/L6/L7/L8 共 14+ flow）→ 唔係 flake。

**R0 謎語解鎖**：R0 摘要「0 字節 request 落 mock」正確（bytesIn=0），但 R0/Stage B 都記作「device 讀返 0 字節」— 實測 device **讀返咗 49B 408**（return 方向通）。51B 謎字節 = Node `HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n` 恰好 51 bytes（R0 20:19:54 同款 `bytesOut:51`）。即 R0 嘅「TCP payload 0 字節重現」= 同一故障，只係當時 probe/nc 未 capture 到 408 而誤讀作「全雙工死」。

**P2（大 response flush 假說）= 反證記錄**：L7 四檔（1KB→1MB，forward 方向）**零 partial forward**（relay bytesIn 全 0，無任何 size 觸發嘅 flush）→ 唔存在「大 payload 觸發 buffer flush」之類嘅 size-dependent 行為。全部 late/partial forward 觀察都係 **lifecycle-event（teardown）觸發**：M5(a) bytesIn:56（Stage B gen3，8KB GET headers 前段）+ L6b/L6d 2 flow **同毫秒** close 時 flush 663B（=`GET … 663B request` 全長）— 即 gVisor 淨係喺 connection teardown 路徑先會 flush 埋 hold 住嘅 data（一次過、唔完整 lifecycle 唔會）。

### L6 — Lifecycle（FAIL 7 / PASS 1）

- **L6a 循序 ×3 / L6b 並行 ×3**：3+3 flow 全部 read-timeout RECV=0 — 多 flow 狀態互相冇救（並行唔會搶返某條 flow 嘅 forward）
- **L6c half-close（8341B）**：RECV=0 — 大 body + half-close 都一樣死
- **L6d clean close**：RECV=0；但 close 記錄捉到 **teardown flush**：
  ```
  {"t":"tcp-close","from":"172.17.0.3:44456","bytesIn":0,   "bytesOut":51,"why":"upstream-close"}   ← 20:47:25.346
  {"t":"tcp-close","from":"172.17.0.3:44454","bytesIn":663, "bytesOut":51,"why":"upstream-close"}   ← 20:47:25.347
  {"t":"tcp-close","from":"172.17.0.3:44468","bytesIn":663, "bytesOut":51,"why":"upstream-close"}   ← 20:47:25.347
  ```
  兩條 L6b parallel flow 喺**同一毫秒**被 flush 埋 663B（完整 request 長）— state-dependent flush-on-teardown 嘅直接實錚（同 M5(a) 56B 同類）
- **L6e timeout（hang relay）/ L6f RST（rst relay）**：同款 read-timeout RECV=0 — 上游點樣死唔影響：forward 方向死喺 gVisor 自己度
- **L6g proxy 拒絕 CONNECT = PASS**：relay 拒 CONNECT → device 2ms 收 `Connection reset by peer`（`rc=read-error … T_TOTAL_MS=2`）+ relay log `tcp-reject-connect` — **控制平面（reject 傳遞）完全正常**，故障純淨限於 data plane forward
- **L6h 恢復 = FAIL**：re-provision（kill + 重起 t2s，同一 production script）後 probe 同款 read-timeout — **重啟 t2s process 冇救**

### L7 — Large payload（全 FAIL，零 partial forward）

| size（request 全長） | probe | TUN dRx（device→gVisor） | TUN dTx（gVisor→device） |
|---|---|---|---|
| 1181B | read-timeout/60s RECV=0 | 112B / 2pkt | 1397B / 4pkt |
| 16544B | read-timeout/60s RECV=0 | 164B / 3pkt | 17332B / 15pkt |
| 65696B | read-timeout/60s RECV=0 | 216B / 4pkt | 68252B / 49pkt |
| 1048742B | read-timeout/60.001s RECV=0 | 3138B / 59pkt | 544014B / 378pkt |

- **零 partial forward**：relay `bytesIn=0` 全四檔；echo 側零 tunnel request — 1KB 都過唔到，何談 8KB/64KB 觸發 flush（MD 預期嘅「大 payload 部分 forward = 重要狀態證據」= **未出現**）
- **dRx 形狀**：全檔平均 ~53–56B/pkt = 純 control packet → **data 從 device kernel 出發都未過 TUN**（§3 L4(e) 定論）。1MB 檔 59 包 control = ~60s 內嘅 keepalive/window-probe 節奏
- **dTx 觀察（未解，留 R3）**：gVisor→device 方向嘅 bytes **隨 request size 放大**（1397→544014B）— return 方向有活動但 relay 只寄咗 408（51B）返；即 gVisor 喺 send 方向做緊某啲同 request size 成比例嘅嘢（ACK 節奏 / window update / 內部 state 活動？）— 需要 gVisor `--restapi` netstats 先拆到，記 R3
- TUN counter 每 60s 一輪連續 4 檔無重置/洩漏，errors/dropped 全 0 全程

### L8 — Regression（DNS PASS / TCP FAIL）

- **L8a DNS canary（UDP ASSOCIATE）= PASS**：device 內 `canary.example` A query → mock 答 `12 34 81 80 00 01 00 01 … c0 0c 00 00 00 01 00 01 00 3c 00 04 5d b8 d8 22`（**QR=1 NOERROR，A = 93.184.216.34**），<1s 落 device；mock UDP 流水 47 筆（**包括 Android 自身 `connectivitycheck.gstatic.com` 查詢經 tunnel UDP 通** — 真實 background traffic 亦行 UDP 路徑）→ **gVisor UDP ASSOCIATE 路徑（forward + return）完全正常**，故障限於 TCP forward data path
- **L8b TCP bidir = FAIL**：同 L4 形狀
- **L8c kill→fail-open→re-provision = FAIL（但捕捉到重要 fail-open 實錚）**：kill t2s 後 `route get 8.8.8.8` = `8.8.8.8 via 172.17.0.1 dev eth0 table eth0 src 172.17.0.3`（table 100 rule 5000 隨 t2s 消失 → **device 自動 fail-open 返物理網**，唔會全機斷網）；re-provision 成功；但 payload 仍 read-timeout — 三重確認 re-provision 冇救

### TUN — `--tcp-auto-tuning` A/B（零差異）

- **源碼**（t2s v2.7.0）：`main.go` `flag.BoolVar(&key.TCPModerateReceiveBuffer, "tcp-auto-tuning", false, …)` = **default OFF**；`engine/engine.go` 開咗先 `option.WithTCPModerateReceiveBuffer(true)` → 控制 gVisor netstack 嘅 TCP moderate receive-buffer 自動調校。go.mod gVisor pin = `gvisor.dev/gvisor v0.0.0-20260701204157-69c2d17aea96`（2026-07-01）
- **A/B 實測**（1KB，flag 確認喺 argv：`ps` 有 `--tcp-auto-tuning`）：
  | | TUN RX | TUN TX | probe |
  |---|---|---|---|
  | OFF（default） | 112B/2pkt | 1583B/8pkt | read-timeout |
  | ON | 112B/2pkt | **1584B**/8pkt | read-timeout |
- **結論：零狀態差異**（byte 級一致，±1B = 計時 jitter）→ **buffer auto-tuning 假說排除**；故障唔喺 receive buffer 調校層

## 4. 逐層排除（MD §4.4 清單）

| 候選故障層 | 判定 | 排除/指認證據 |
|---|---|---|
| DNS | ✅ 排除 | **L8a PASS**（UDP canary NOERROR + A 記錄 <1s；Android 自身 connectivity check 經 tunnel UDP 通）；R0 已 PASS |
| 路由（table100/rule5000/gateway 例外） | ✅ 排除 | L2 全部正確 + `route get` 實錚；L1b 直打走同一 gateway 例外路徑正常；L8c fail-open 行為正確 |
| 權限（TUNSETIFF/cap） | ✅ 排除 | L3 process 正常運行、TUN UP、CONNECT 能 dial（需要 CAP_NET_ADMIN 嘅部分全部完成） |
| MTU/分片 | ✅ 排除 | L2 兩端 1500 一致；L1b 直打同尺寸無 problem；forward 0 字節連 1KB（單 segment 以內）都過唔到 → 唔係 fragmentation 問題 |
| TCP buffer tuning（auto-tuning/rcvbuf/sndbuf） | ✅ 排除（auto-tuning） | TUNA/TUNB A/B byte 級零差異；rcvbuf/sndbuf 靜態值未測（R3 可排，低預期） |
| binary 版本 | ⚠️ 指认为載體（非根因層） | v2.7.0 pin 正確、`--version` 對；根因喺佢內置 gVisor（pin = `v0.0.0-20260701204157-69c2d17aea96`，2026-07-01）。上游 gVisor 之後有 13 個 release（至 20261012.0）— release notes 冇記錄到本故障類型嘅 fix（見 §5） |
| 代理（SOCKS5 relay） | ✅ 排除 | mock 本身 = 簡單 relay；L1a/L1b 直打同一 sink 正常；mock log 逐筆自證（bytesIn=0 係**入 mock 之前**已經冇）；P3 fidelity 複核（coalesced CONNECT+payload 668B → exact echo 零問題） |
| 測試方法（mock relay bug / nc 用法 / TUN counter 解讀） | ✅ 排除 | 測試方法自己先經 L1a/L1b 驗證（同一 probe/endpoint 直打 PASS）；408 字節逐字核對（51B 精確長度）；TUN counter 語義用 **kernel source（v6.8 tun.c）定論**；settle=1000ms 排除 timing |
| gVisor netstack TCP proxy（forward 方向） | ❌ **指认為故障層** | 邊界表（§3 L4）每條邊界獨立證據；UDP 路徑對照正常（L8a）→ 淨限 TCP forward data |

## 5. 上游線索（read-only 分析）

- tun2socks v2.7.0 pin 嘅 gVisor = **2026-07-01** pseudo-version（`v0.0.0-20260701204157-69c2d17aea96`）；gVisor 現行最新 = `release-20261012.0`（中間 13 個 release）
- 已知同類：**google/gvisor#10243**「TCP connection stall, avoided by disabling AutoTuneSndBuf」（2024-04 修復，`pkg/tcpip/transport/tcp/endpoint.go` windowClamp/send-buffer shrink 後冇 re-notify write-ready 之類嘅 netstack 狀態機 bug）— **呢條 fix 2024 已入我哋 pin（2026-07 之後）→ 我哋呢個唔係 #10243**；但佢證實「gVisor netstack TCP stall（proxy 卡喺 write-ready 通知 / buffer 狀態）」係**已知 bug 類別**，而我哋嘅失敗形狀（forward 方向無 ACK 無 forward、return 正常）同佢係同一類別嘅**反向/變體**
- 2026-07 → 2026-10 嘅 13 個 release notes 內**冇搵到**明確記錄本故障（TCP forward data stall / zero-ACK）嘅 fix（web 核對，release 頁 commit 列表無相關條目）→ Option A 係「值得試但未保證」，唔係「已知修好」
- **gVisor 內部卡死點未定位**（netstack 哪個 function/state）— 需要 gVisor 源碼級 instrument / `--restapi` netstats（R3 範圍）

## 6. REDIRECT 線（reviewer Option B）最小驗證

**MD 紅線遵守**：host firewall/iptables **零改動**（全程只讀：`lsmod`、`/proc/net/ip_tables_names`、container 內 `iptables -L`）；實測只喺 spike 容器 netns 自閉環（RDa teardown 亦係 spike 自己嘅 tunnel）。

**機制分析（code/doc 證據）**：
1. **tun0 存在邊**：`ip link show` 喺 **host netns 零 tun\***（實錚）→ tun0 喺容器 netns（t2s 用 `--device tun0` 喺容器內 TUNSETIFF）→ **device kernel ↔ tun0 ↔ gVisor 呢段 traffic 完全唔經 host netfilter**（Linux netfilter hooks 係 per-netns；`Documentation/networking/namespaces.rst`：每個 netns 有自己嘅 network stack 同 netfilter 規則）
2. **host netfilter 望到嘅**：淨係 veth→bridge 呢段 = gVisor→host 嘅 **SOCKS leg**（container IP → 172.17.0.1:20082）— 而呢段 endpoint 我哋配置（`socks5://` URL）已經可以改，REDIRECT 佢 = 冇新能力
3. **結論**：host 側 REDIRECT **機制上摸唔到故障段**（device→gVisor 嘅 data 喺容器 netns 內 + gVisor user-space，host netfilter 無視點）；REDIRECT 即使生效，救唔到「gVisor 唔 forward」，因為故障段嘅 bytes 根本冇離開 gVisor user-space

**容器內自閉環實測（MD §4.3 RD 線）**：
- **RDa = PASS**：tunnel teardown 後 tun0 消失；`iptables v1.8.7 (legacy)` 存在
- **RDc = BLOCKED**（雙牆，獨立證據）：
  - 牆①：`iptables -t nat -L/-S` → `Table does not exist (do you need to insmod?)` — `iptable_nat` module 冇 load（host `lsmod` 確認只有 `ip_tables` core + nft 家族；`/proc/net/ip_tables_names` 喺容器 netns **空**）；容器無 `/lib/modules` → 容器內 insmod 唔到；host 側 insmod = 改 host 狀態 = 紅線
  - 牆②：`-j REDIRECT --to-ports` → `unknown option "--to-ports"` — **Android netd iptables build 未編 xt_REDIRECT**（即使牆①開咗都唔行）
- → **容器內 REDIRECT pilot 喺本平台（redroid 14 + Android iptables build + host kernel 6.8 無 iptable_nat）= 唔可行**；呢個唔係測試問題，係平台能力缺失（BLOCKED，唔係 FAIL）

## 7. 修復選項評估（每項明確定性結論）

### Option A — 重 build t2s 用新 gVisor（release-20261012.0）

| 維度 | 評估 |
|---|---|
| 可行性 | **行**。t2s 係 Go 模組：`go.mod` 改 `gvisor.dev/gvisor` version → `go build`（linux-amd64 static）。13 個 release 之間 netstack 有大量 TCP 相關 commits（release 頁 commit 列表：route/bridge/GRO/drain 等），**但冇任何一個明確記錄修本故障類型** → 係「升上去試」，唔係「已知修好」 |
| 授權 | gVisor = BSD-3（兼容）；t2s v2.7.0 本身授權需核 v2.7.0 LICENSE（MIT 類 — 可改可分發，加自己的 patch 記錄）。R1 已有 pinned-build + sha256 驗收流程可複用 |
| 風險 | ① 行為變化：gVisor 13 個 release 嘅 netstack/syscall 變化 → **必須重跑本八層 + R0/R1 全套回歸**先可以收 ② 可能修唔到（故障喺 pin 之後未修）→ 時間成本 ③ t2s 上游對新 gVisor API 嘅相容性（engine.go 用 `option.WithTCPModerateReceiveBuffer` 等 API — 版本漂移可能 break compile，要跟 API 對齊） |
| 回滾 | 完整：image 層（pin 文件 + build）revert → 返 v2.7.0/20260701；設備級唔需要遷移（binary 冪等部署） |
| **結論** | **行（建議 R3 首選）**：成本 = 1 個 build + 八層重跑 + 回歸；唔行嘅後果 = 確認要 Option C。**唔建議 R2 內執行**（MD：R2 只做診斷 + 報告） |

### Option B — REDIRECT 路徑

- **host 側**：**唔行**（機制上摸唔到故障段 — §6 分析：tun0 喺容器 netns，device→gVisor 流量唔經 host netfilter；host 望到嘅淨係已經可配置嘅 SOCKS leg）
- **容器內**：**唔行（本平台）**（§6 實測 BLOCKED：iptable_nat module 缺失 + Android iptables build 無 xt_REDIRECT；要行需要 host kernel 加 module + 自製 container 內 nft userspace = 已超出「REDIRECT」範疇，變 Option C）
- **結論**：**唔行（兩條路都斷，有實錚）**。死心。

### Option C — tunnel 實作替換（MD §4.5 格式）

候選 = host-side 輕量 TUN/L4 relay（繞過 gVisor），例如 host 跑 TPROXY/REDIRECT 捕 container→host 嘅 SOCKS leg 上游、或者 device routing 改指 host relay。**只評估、唔實施**：

| 維度 | 評估 |
|---|---|
| 相容性 | 要改 device 路由模型（default → host relay endpoint）+ t2s 整體替換（tun0 消失、table100/rule5000 邏輯重寫、setup/teardown script 全部重做、R1 binary 部署契約失效）；API/DB 層（gostPort/proxyUrl 契約）可保留形狀 |
| 授權 | 自寫 relay（Node，repo 既有 stack）= 無第三方授權問題（反而甩咗 gVisor/t2s 依賴）；host TPROXY 需要 host kernel nft/xt 能力（本 host 有 nft 家族 — 可行） |
| 架構 | **最大**：故障段（gVisor 內部）完全繞過 = 根本修；但引入 host-side daemon（fleet 每機要有）+ host firewall 規則（**撞 MD 紅線嘅區域 — 生產化要先過安全審**）+ 每 container 一條 relay 流嘅 host 狀態 |
| 平台 | 依賴 host kernel ≥ 4.x netfilter（OK）+ host 有 nft userspace（本 host OK，但 fleet 一致性要審）；Android 側反而變簡單（淨係 routing） |
| 維護 | 多一個 host daemon 要 monitor/upgrade/告警；relay 本身要解決 gVisor 原本幫我哋做嘅嘢（NAT 回包、多 flow 並行、UDP ASSOCIATE、MTU）= 自己寫 mini netstack 嘅 70% 工作量，風險唔係甩咗而係**搬咗** |
| 回滾 | 差：涉及 host 層狀態（daemon + firewall 規則）+ device 路由 — 回滾 = 全 fleet 操作，唔係 image revert 咁乾淨 |
| **結論** | **技術上可行、但係最後一步**：cost/風險/維護 都大過 Option A；只喺 Option A 重跑八層唔過先值得開工。需要獨立 ticket + 安全審（host firewall 規則） |

### 排序（R3 建議）

1. **Option A**（升 gVisor pin 重 build t2s）— 八層重跑；過 = 收，唔過 = 2
2. **Option C**（host-side relay 替換）— 開 ticket + 安全審
3. Option B — 死（實錚喺檔）

## 8. 未解決 / 保留（R3 範圍）

- gVisor 內**具體**卡死點（netstack 哪個 function/state）未定位 — 需要 gVisor `--restapi` netstats（per-connection sent/recv/window/retrans）+ 源碼級 instrument
- **dTx（gVisor→device）隨 request size 放大**嘅內含未解（L7：1397→544014B）— return 方向 gVisor 喺做咩同 request size 成比例嘅嘢（ACK 節奏/window update/內部活動？）— restapi 可以拆
- teardown flush（L6b/L6d 663B 同毫秒 / M5a 56B）嘅觸發狀態未明（gVisor connection close 路徑 flush held data — 為咗 debug 可以「利用」：teardown 前嘅 data 會補落，但 lifecycle 內冇用）
- `--tcp-rcvbuf/--tcp-sndbuf/--mtu` 靜態調參未測（低預期：A/B 已證 auto-tuning 無效，靜態 buf 大概率無效；每樣一個變量各一轮，R3 可排）

## 9. 修復記錄（R2 範圍內、已確認、獨立 commit）

1. **probe 工具 bug（自己嘅）**：`signal()` 帶 SA_RESTART 使 read-timeout 失效（30s 變 60s+）→ 改 `sigaction` 無 SA_RESTART + close 前 `SO_LINGER{on,0}` + 15s send-window alarm（`tests/tools/probe.c`）
2. **R1 缺口修復（binary shadowing）**：fresh /data volume 遮埋 baked `/data/local/tmp/tun2socks`（R1 定性，R2 修）→ binary 第二落點 `/usr/local/bin/tun2socks`（Dockerfile COPY）+ setup script self-heal（conditional cp + chmod 0755，喺 nohup 之前）+ check script v2（wa-t2scheck-v2：canonical→fallback，`BINARY_DETAIL=fallback(path)`）+ tests（hermetic ×4 分支 + **真 image 實測**：booted R1 spike 上 missing RC=3 復現 gap → fallback not-executable RC=4 fail-closed → fallback ready → self-heal 還原 sha256 一致）。**獨立小 commit**
3. **driver 修復（spike infra）**：L8a `nc -u` 無 read timeout 死等（toybox nc UDP 無 EOF）→ `timeout 6 nc -u …`；RD `--to-ports` 平台支援偵測 + BLOCKED regex（`Table does not exist|insmod|unknown option`）；L7 加 16KB 檔位；tuning A/B phase

## 10. 機制圖（R2 定性）

```
 device kernel (10.8.0.2)        gVisor netstack (t2s v2.7.0)         host relay (172.17.0.1:20082)   echo (20271)
 ─────────────────────────        ──────────────────────────────        ──────────────────────────────   ──────────
 TCP SYN ════════════════════►  netstack 收 SYN，dial 上游：
 （data 入 send queue）           SOCKS5 CONNECT ──────────────────────► 200 OK
 ◄════════════════  SYN-ACK     （ACK 正常）◄────────────────────────────
 ACK + [data segment 1…N]         ✗✗✗ 卡死點：netstack TCP endpoint
    ║  device kernel:             forward 方向停止 consume/ACK
    ║  無 ACK / window 0 效果      → 0 bytes 過 TUN（TUN RX = control only）
    ║  → data hold 喺 kernel       → 0 bytes 到 relay（bytesIn=0）
    ║    send queue（零重傳）
                                        60s: Node headersTimeout
                                        408 (51B) ────────────────────►（relay 收 0 字節都答）
 ◄════════════════  49B/51B 408  （return 方向通）◄──────────────────────
 TCP close（device/probe 收 response 後）
    teardown 路徑：hold 住嘅 data 一次過 flush（L6b/L6d：663B×2 同毫秒；M5a：56B）
 UDP ASSOCIATE（DNS）：✅ 全通（canary NOERROR + A <1s；Android connectivity check 經佢通）
```

## 11. 回滾

- 本單**零生產改動**（spike 容器/mock/ADB 全用完即清；host firewall **零改動**；host kernel module 零 load）
- 新增檔案全部係 tests/scripts/docs（driver 修改喺 spike infra commit 內）— 回滾 = revert commits
- R1 缺口修復嘅 production 效果：Dockerfile 第二 COPY + script 行為變化 — 回滾 = revert 該 commit（image 重建）；fallback/self-heal 邏輯本身 fail-safe（canonical 健康時零行為變化）

## 12. 验收狀態

- MD §4.3 八層：L1–L3 PASS / L4–L5 FAIL（定性）/ L6 7F+1P / L7 4F（零 partial forward）/ L8 1P+2F（DNS PASS 重要排除項）— **全做完**
- tcp-auto-tuning：源碼查（default OFF）+ A/B 實測（零差異）— **做完**
- RD 線：理論分析（§6）+ 容器內實測（BLOCKED 雙牆實錚）+ **零宿主 firewall 改動** — **做完**
- 報告：8 層總表 + 每層證據引用 r2-evidence/ + 根因 + 機制圖 + Option A/B/C 明確定性結論 — **本文**
- R1 缺口：獨立小 commit + hermetic + 真 image 驗證 — **做完**
- 回歸：`npm test` **517 tests / 516 pass / 0 fail / 1 skip**（基線 515/514/0/1，+2 新 test 全綠，零回歸）
- 清理：spike 容器 stop+rm、mock kill、adb disconnect、port 釋放 — 見 progress log 收尾段

---

## R7 Addendum（2026-10-21 — 文檔同步交叉核，MD §9.1）

> 本節不推翻上文（R2 診斷紀錄保持原狀）。上文嘅 spike 觀察喺**嗰個 spike 拓撲**
> （device → t2s → **host 直接 mock socks5 relay**，無 gost）係真實、可重現、有證據
> 嘅（L4–L8 全矩阵）。R3/R4 live 之後，產品鏈路嘅實際狀態同上文結論有重要差異 —
> 讀本文檔嘅人必須兩段都讀。

### A. R3 發現嘅 production 層 bug（a34baad）— 改寫「TCP 唔通」嘅語境

R3 live 開頭先發現：Stage B（ffe800f）起，**所有 provisioned gost container 喺 ~73ms
內 Exited(1)**（`fatal: Config File "gost" Not Found` — pin 咗嘅 gogost/gost image
ENTRYPOINT 係 `["/bin/gost"]`，舊 Cmd 多咗個 `start` arg 被 gost CLI 當 config file
name 解析）→ **產品鏈嘅 device→proxy 一脢由 Stage B 起就係死嘅**（mock E2E 喺
docker 層 mock 咗，冇捉到）。`a34baad` 修復（Cmd 落 `start`）+ 3 fixture pin。
⇒ R2 spike（無 gost 拓撲）觀察到嘅 stall 同「產品鏈 TCP 狀態」係兩回事。

### B. R3/R4 live：產品鏈（t2s → gost → upstream）雙向 TCP canary **PASS**

R3 live（`docs/live-evidence/r3-20261020/`，真 Redroid + 真 t2s + 真 gost 容器）：
create → HEALTHY 23s，canary = **雙向 TCP payload（nonce + sha256 回顯，latency
1000ms）** 經完整真鏈 device kernel → tun0 → t2s → socks5(gostPort) → gost 容器 →
mock socks5(16095) → canary echo(16090) — **R2 spike 嘅 forward stall 喺產品鏈未
重現**（canaryHits 持續增長 = 鏈路持續流通；R4 live 同樣 HEALTHY→kill→BLOCKED→
recovery→HEALTHY 全循環 canary PASS）。

### C. 機制裁定：仍然 open（誠實保留，唔猜結論）

- R3 結語「R2 gVisor attribution = mechanism-level wrong」嘅理由係「host 無 gVisor
  **runtime**（runc）」— 呢個理由**唔成立**：R2 指嘅 gVisor 係 **t2s 內嵌 netstack**
  （`gvisor.dev/gvisor v0.0.0-20260701204157`，t2s 進程內嘅 userspace TCP/IP 實現），
  同 container runtime 係兩層；兩個環境跑緊嘅係同一個 t2s binary（同一 sha256）。
- 正確口徑：**R2 spike 拓撲（t2s 第一跳 = 裸 mock socks5 relay）嘅 forward stall
  根因未完全裁定**；spike 同產品鏈唯一結構性差異 = 第一跳 relay（mock vs gost
  容器）。候選因素（未測）：第一跳 relay 對 gVisor netstack TCP framing（coalesced
  CONNECT+payload / window 行為）嘅處理差異 vs gVisor netstack 自身狀態機（§8 未解
  清單：restapi netstats instrument 未做）。
- **產品影響 = 無（現行配置）**：產品鏈嘅 t2s 第一跳**永遠係 per-device gost 容器**
  （`provisionGost` 同步、create 時起；`socks5://172.17.0.1:<gostPort>`）— 無「裸
  第一跳」配置存在。若日後引入非 gost 第一跳拓撲，**必須重跑本八層矩陣**（R2
  證據仍有效為該拓撲嘅警示）。
- **持續防線（已實錚）**：watchdog 每 30s 跑同一條雙向 TCP canary（`REDROID_HEALTH_POLL_MS`）；
  HEALTHY 唯一入口 = fresh canary PASS（transition table 結構性保證）；任何 data-plane
  回歸 = DEGRADED→BLOCKED（R3 Phase B live 實錚：canary-down 3s 內 DEGRADED、
  recoveries 保持 0 唔亂 re-provision）— 即使 stall 喺某拓撲存在，**唔會產生假
  HEALTHY**。

### D. 對 §6/§7 結論嘅修訂（只改判定，唔改證據）

| 項 | 原文 | R7 修訂 |
|----|------|---------|
| §7 Option A（升 gVisor 重 build） | 「R3 首選」 | **降級為 backlog**（無產品影響 — 產品鏈 canary 持續綠；若未來 canary 喺產品鏈變紅，先按 §8 restapi 清單定位 + Option A/C 重評） |
| §7 Option B（REDIRECT） | 死（實錚） | 不變（容器內雙牆實錚仍成立） |
| §7 Option C（host relay 替換） | 最後一步 | 不變；另加一個未記錄嘅維度：呢條路同時係 §A 未解根因嘅繞過方案（若日後要引入非 gost 第一跳） |
| §0 一句話結論 | 故障層 = gVisor netstack TCP forward | **scope 限縮**：= R2 spike 拓撲（裸第一跳）下嘅 forward 故障層指认；產品鏈（gost 第一跳）未重現；機制裁定 open（§C） |

### E. 本 addendum 嘅證據指針

- R3 live 總結 + 四 phase 時間線 + recovery ledger：`docs/live-evidence/r3-20261020/summary.md`（+ 4 個 phase log）
- R4 live（UI 文字驗證 + audit row 實抽）：`docs/live-evidence/r4-20261020/`（6 截圖 + `audit-net-events.txt`）
- fail-closed 全矩陣（hermetic + live）：`docs/audits/fail-closed-validation.md`
- gost Cmd bug 修復：commit `a34baad`（message 內有 73ms Exited(1) 證據 + 全鏈 curl 200 nonce+sha256）
