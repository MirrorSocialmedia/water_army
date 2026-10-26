# W1 probe findings (2026-10-26 23:3x HKT) — device redroid-rdev-probe (identity a1)

## Verified facts
1. **Carrier delivery = PASS (9/9)**: container Cmd carries all `androidboot.wa_*`
   (sorted, stable order); guest exposes each as `ro.boot.wa_*` verbatim
   (nubia/Legion2CE profile for a1 — brand/model/device/name/manufacturer/buildId/displayId/fingerprint/serialno).
2. **ro.* mapping = NOT in effect**: `ro.product.*` / `ro.build.*` remain stock
   redroid14_x86_64 / UD2A.240505.001.W1 / redroid build. (ADR-025 item 5 flagged this
   as an unverified assumption — confirmed.)
3. **V7 fallback probes (live, root, SELinux=Disabled)**:
   - `setprop ro.product.model X` → REJECTED ("Failed to set property ... See dmesg") — property_service ro-lock holds even for root with SELinux off.
   - `setprop ro.boot.test_probe hello` → ACCEPTED (ro.boot.* settable post-boot by root).
   - `resetprop` binary: NOT present in image (probed /system/bin, /system/xbin, /apex/com.android.runtime/bin).
4. **Conclusion**: carrier path alone cannot rewrite ro.product.*/ro.build.*/ro.serialno.
   W1 activation requires an **image-level change** (init-time ro.boot.wa_* → ro.* mapping
   before the ro-lock, e.g. patched init.rc in the redroid image). Per ADR-025 the switch
   stays OFF in production until V-matrix fully passes.
5. Consequence for this ticket: V1-V4 (ro.* equality) = expected FAIL recorded honestly;
   V-carrier (ro.boot.wa_* equality) = the effective assertion; V5 stability applies to
   the carrier map; V6 = NOT VERIFIED (no target platform on scratch); V7 = done above
   (no viable post-boot mechanism on stock image).

## Side findings (product/infra)
- **Stale Prisma client incident**: generated client in node_modules lacked W3
  `egressState` fields → live `device.create` 500 (PrismaClientValidationError) while
  hermetic suite (fakes) was green. Fixed via `npx prisma generate`; bringup.sh now
  regenerates after migrate. → process gap: no test asserts generated-client ↔ schema sync.
- `docker exec psql` returns rc=0 on SQL errors without `-v ON_ERROR_STOP=1` (silent
  failure mode; all harness psql helpers now carry the flag + input pipe).
- probe boot: container up in <1 min, Android sys.boot_completed=1 ~16 min (cold dataDir);
  host adb needs explicit `adb connect 127.0.0.1:<port>` (platform refresh does the connect).
