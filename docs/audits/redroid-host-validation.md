# Redroid Host Validation — 實機驗收記錄（P0 Phase 5 / MD §7）

> 交付物：施工 MD §11「必須交付的檔案」— `docs/audits/redroid-host-validation.md`
> （R5 交付時未落成獨立審計檔；R7 文檔同步交叉核時補建，內容以
> `docs/live-evidence/r5-20261020/` + `docs/p5-evidence/` 原始證據為準。）
> 日期：2026-10-20（R5 live）；補建：2026-10-21（R7）

## 0. 驗收環境

- 真 Redroid host：runc（kernel 6.8.0-117-generic x86_64）+ **RTX 3090 ×2**
  （driver 580.178.04，nvidia runtime）；binder_linux（/etc/modules）+
  binderfs（/etc/fstab）已 persistent；`/var/lib/water-army` 資料卷。
- fleet image：`water-army/redroid:14.0.0-240527-matrixa-r3`（repo Dockerfile
  重建 — R1 pinned tun2socks 2.7.0 baked + /usr/local/bin fallback 雙落點）。
- 隔離紀律：全部 live 工作喺 `redroid-matrix-r5-*` 容器 + 獨立
  `/var/lib/water-army/redroid-r5` 卷；ADB spike 範圍 162xx（16200）；
  禁口範圍（15532/15432/3001/3008/3011/3100/3101/9800/30000/15000–15999）
  零觸碰；user compose 6 容器 + SGLang 零 stop/modify（§7.5 實核）。

## 1. §7.1 Host preflight（productized — `apps/api/src/cli/preflight.js`）

Live read-only 跑法（**永不 mutate host**）：docker-daemon / binder-module /
binderfs-mount / shared-memory / kernel-compat / adb-exposure / data-volume
全 PASS；`gpu-visibility` 按設計 WARN（nvidia-smi 可見 ≠ Android render 證明，
MD §2.4）。verdict WARN（binder=true, docker=up）。`--fail-on-warn` → exit 1
（嚴格 gate 模式）；plain → exit 0。
- 範圍感知：`REDROID_ADB_RANGE_START/END=16200/16299` 時，loopback 16200
  listener 正確唔 flag。
- vantage 誠實：由 container 內跑時，host-namespace 項目報 WARN/UNKNOWN，
  **唔會假綠**。
- 定位：preflight = WARNING 輸入，唔係 verdict — create/start 照常進行
  （MD §2.3）。
- 證據：`docs/p5-evidence/01-real-preflight.json` + live 輸出（summary §7.1）。

## 2. §7.2 Fresh Redroid 驗證（fresh build → binary staging → create → ADB → 持久化）

Device `redroid-matrix-r5-fresh`，ADB 127.0.0.1:16200（loopback only）：
1. Fresh container boot → `sys.boot_completed=1`（冷首次 **~24 min** — 即 R6
   boot-timeout 2400s 校準嘅實錚基礎）。
2. `getprop`：Android 14 / SDK 34 / `redroid/redroid_x86_64` /
   `ro.boot.redroid_gpu_mode=host`（`getprop-fresh.txt`）。
3. ADB local secure connect（loopback only）。
4. **真 APK**：F-Droid client 2.0.2 安裝、`am start`、
   `org.fdroid.fdroid/org.fdroid.MainActivity` focused window 確認。
5. **持久化**：`/data/local/tmp/r5-persist.txt` marker → stop → **recreate 同
   volume** → 讀返 OK + F-Droid 仍在（`final-assert.txt`）。
6. **資源限制（R5 補嘅 product gap）**：`RedroidTemplate.cpuLimit /
   memoryLimitBytes`（nullable，NULL = 無限）。Live `docker inspect`：
   `Memory=4294967296 NanoCpus=2000000000` +
   `DeviceRequests=[{Driver:"nvidia",Count:-1}]`
   （`limits-docker-inspect.txt`）。migration `20261020235900`（additive
   nullable，既有 row 唔受影響）。
7. **負測試**：壞 pinned tag → create fail-fast `DOCKER_ERROR (HTTP 404)
   No such image`，**無無限重試**（`bad-image-negative.txt`）；boot-timeout
   fail-closed 證據喺 `../r3-20261020/`。
- fresh build 唔依賴開發者本機臨時檔案或手動 `adb push`（image 自帶 pin +
  fallback 雙落點；R1 契約）。

## 3. §7.3 網絡同安全隔離

- ADB bind `127.0.0.1:16200` only（docker port + preflight exposure scan），
  永唔 0.0.0.0。
- Docker socket：`srw-rw---- root docker`（**唔係 666**）；只 api service
  mount（read-only）+ `/var/lib/water-army` rw。
- 容器 allowlist：`isManaged()`（app.managed label / admin exception）；
  `routes/containers.js` → 403 NOT_MANAGED + audit。
- Shell-injection audit（redroid 路徑）：**無 `shell: true`**；ADB =
  fixed-binary `execFile` argv；in-container script 只跑 unit-tested builder
  輸出 + integer-port 驗證。
- Preflight read-only 不變式。

## 4. §7.4 GPU 驗收（measured，非 configured-as-success）

- 設備內 render 路徑 = **真硬體**：SurfaceFlinger（pid 593）hold 7 open fds
  on `/dev/dri/renderD128`；renderD128 = PCI 10DE:2204 = **RTX 3090 #0**
  （`gpu-fd-root.txt`, `gpu-card-mapping.txt`）。
- logcat：`SurfaceFlinger: Enabling backpressure for GPU composition` +
  `RenderEngine with GLES Backend` + libEGL_mesa（`gpu-logcat.txt`）。
- render 期間 nvidia-smi：GPU0 **37%**（SF 合成 app 期間；GPU1 97% = SGLang
  user service，唔係我哋嘅）（`gpu-util-during-render.txt`）。
- `screencap` → 1080×1920 RGBA PNG = 真合成幀（`screencap-fdroid.png`）。
- `gpuStatus` 語義：in-device render check 通過前保持 `unverified`/
  `software` — **配置唔會單方面翻綠**。
- 負結果（誠實記錄）：`swiftshader_indirect` 喺本 host **boot 唔到**
  （surfaceflinger EGL crash loop；R3 crash buffer）。
- **Live 發現 + 修復（R5）**：partial `PUT /api/redroid/templates/:id`
  會靜默 clobber `gpuMode→swiftshader_indirect` + `privileged→false`
  （AJV create-schema default 套到 absent PATCH field）— 實錚後果：
  recreate 後 `Privileged=false` → binderfs mount `Operation not permitted`
  （exit 126）。修復：`TEMPLATE_PATCH_BODY` strip `default`（absent 保持
  absent）；regression lock = `tests/integration/redroid-resource-limits.test.js`
  （守門 test，R7 每次 npm test 照跑）。

## 5. 已知限制（實機層，R7 決定：記錄 + 追索方向，唔定位到）

- **adbd recreate-stall**：delete+recreate（第 2 cycle）後 Android framework
  完全 boot（boot_completed=1、app 行緊、marker 持久化）但 **adbd 停答 host
  protocol**（TCP accept 得、`HOST:version` 零 bytes 30+s；transport
  registered→immediately offline；epoll 中唔係 hard-block）。`ctl.restart
  adbd` + 全容器 API restart 都復唔到。產品診斷正確報
  `containerState=running + adbState=offline`（honest state，無假陽性）。
  同 session 早前 fresh boot + stop/start 嘅 ADB 全部正常（getprop/install/
  screencap 證據）→ **recreate 特有嘅 container-runtime quirk，非產品
  回歸**。image/內核層 root cause 未定位（追索方向：redroid image adbd auth
  relay on recreate / binder transport 重掛時序）— backlog，另開單。
  口徑：R6 adbd stall 決定（decide-and-defer + 文檔化）— 見
  `docs/audits/release-gate-r7.md` R6 handoff 決定段。

## 6. 回滾

R5 code（preflight CLI、cpuLimit/memoryLimitBytes + migration
`20261020235900`、TEMPLATE_PATCH_BODY strip-default、gpuStatus 語義）回滾 =
revert R5 commits；migration 係 additive nullable — 回滾 code 後欄保留無害
（principle：migration 只前向）。host persistent 設定（/etc/modules、
/etc/fstab、/var/lib/water-army）唔受 repo 回滾影響。
