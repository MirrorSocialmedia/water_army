# stealth6-v1 Build Record (WA-STEALTH6 gen2, 2026-11-03)

## Image chain
- base: `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth5` = `sha256:2de5d82a…` (pinned in build.sh BASE_WANT)
- stealth6-v1 final: **`sha256:344980b84edff32ad784e0ef2d7752cc3d446d9dfcbe9f0bfecdc3618031ab9f`**
  (first build `a040f3b058c4…` was pre-HAL-fix; superseded)
- COPY-only Dockerfile (no RUN, no network); build.sh byte-pins every COPY target
  byte-exact vs context + `oem-ro-map.rc` drift guard vs stealth5 context.

## Contents baked
1. **T1 abi props** — `stealth6-extras.rc` sets the 4 `ro.product.cpu.*` rows via
   `/vendor/bin/oem-propctl` under `load_persist_props_action` (boot contract,
   survives fresh boot). Verified on-device: abi=`arm64-v8a`,
   abilist=`arm64-v8a,armeabi-v7a,x86_64` (x86_64 tail kept — removing it bricks
   zygote fork, gen1 evidence), abilist32=`armeabi-v7a,armeabi,x86`,
   abilist64=`arm64-v8a,x86_64`.
2. **T2 sensors HAL** — hand-built minimal AIDL `ISensors` v2 (`wa-sensors`,
   source + `build_host.sh` in `hal/`, binary committed):
   - `files/vendor/bin/hw/android.hardware.sensors-service.example`
     sha256 `0c1e94248d51c7d1eaacdbff190dd0240163c8727c7a9c41d01b1140d53ec2bb` (32,576 B)
   - 3 sensors: BMI260 Accelerometer / BMI260 Gyroscope / VCNL36827 Proximity
     (handles 1/2/3, types 1/4/8, constant values)
   - VINTF fragment `/vendor/etc/vintf/manifest/android.hardware.sensors.xml`
     (runtime dir merge); init rc `vendor.sensors-default` (class hal, non-lazy)
   - `/vendor/lib64/{android.hardware.sensors-V2-ndk.so, common-V2-ndk.so,
     common.fmq-V1-ndk.so}` extracted from base (vendor namespace can't reach
     system-only generated NDK libs). `libbinder_ndk` NOT copied (allowlisted).

## HAL iteration chain (all crash-verified on fx2, crash buffer → file → host grep)
1. `CANNOT LINK … sensors-V2-ndk.so not found` → bake generated NDK libs to /vendor/lib64.
2. SIGSEGV pc=0 in `asBinder()` (weak-ref bookkeeping read at device offsets our
   minimal CInterface lacks) → call exported `BnSensors::createBinder()` directly.
3. SIGSEGV fault-addr 0 on `fprintf(stderr)` — bionic exports `stderr` as the FILE
   struct itself (host glibc expects a pointer var) → `write(2)` + `__android_log_print`.
4. `~SharedRefBase` assert "double-owned" → keep svc + binder refs for process lifetime
   (never dispose).
5. `AServiceManager_addService` returns binder_exception_t (0=OK) in this NDK gen,
   not bool → registration fixed; added binder thread pool; `ScopedAStatus::ok()`
   via exported `AStatus_fromExceptionCode(EX_NONE)`.
6. **Scudo "misaligned pointer" crash-loop** (getSensorsList unparcel) — root cause:
   host libstdc++ containers crossing the binder glue boundary. The device glue
   (libc++) treats our out-param vector/string with libc++ layouts. Fix:
   - SensorInfo string fields → `WaString` = libc++ string POD mirror
     (24 B, alignas(8); short form: byte0=(len<<1), data@1; long form:
     {data@0,size@8,(cap<<1|1)@16}); sizeof(SensorInfo)=144 static-asserted.
   - out-param treated as raw libc++ vector {begin,end,endcap} long-form — we
     malloc element storage, fill, hand layout back; device glue destroys elements
     and frees. No host container ops cross the boundary. (First fix attempt had
     the short string size byte at [23] → names lost first char; corrected to [0].)

## Field test (fresh-boot image, zero docker-cp hot fixes; fx2 on 344980b8)
- boot_completed ~5–20 s; no crash loops; HAL `running` + registered (service list #18).
- **Layer 1** `dumpsys sensorservice`: `Total 3 h/w sensors, 3 running`; names/vendors
  exact (BMI260 Accelerometer|Bosch, BMI260 Gyroscope|Bosch, VCNL36827 Proximity|Vishay);
  accel consumed live by WindowOrientationListener + FaceDownDetector.
- **Layer 2** framework SensorService list = SensorManager backing list: 3 sensors +
  AOSP software sensors ✓ (screenshots `docs/audits/stealth6/screens/`).
- **Layer 3** DevCheck AI 2.9.2 (com.deviceinsight.ai): **Trust 10/100** ("Not a genuine
  device (Cloud phone)" — score capped at 10), **raw = 100−54 = 46**. Breakdown:
  networking −25 (eth0) · **native cross-check −15 (hook [hook:wx_segment])** ·
  **core sensors −8 — Accelerometer found, Gyroscope found, Proximity not found** ·
  model-vs-chip −3 (Nothing/Galaxy6FS not in DB) · USB debugging −3.
  sensors −15 → −8 vs gen1 (accel/gyro accepted); abi check no longer flagged.
  Hidden items recorded honestly: cap is back to 10 (not 25); new −15/−8 rows.
  DevCheck uninstalled after reading (fresh image had it absent pre-test ✓).

## Known next-gen leads (not fixed here)
- Proximity "absent" at DevCheck while present in SensorService list — framework
  proximity flag special-case rewrites our flags (0x416 → 0x12 in dumpsys); DevCheck
  check likely probes wake-up/broadcast semantics — investigate flags/fifo next pass.
- `hook:wx_segment` = native cross-check W|X segment tell (ndk_translation JIT on
  arm64 .so under x86_64 runtime) — structurally tied to translation, not our HAL
  (our maps clean).
- SensorService only reconnects AIDL HAL on zygote restart (wrapper connect once at
  system_server start) — fine in production boot ordering; remember for restart-debug.
