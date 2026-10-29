/**
 * WA-VMSTEALTH — battery story provisioning (S2, S1 §3 ruling (a)).
 *
 * The redroid health HAL finds no /sys/class/power_supply device in the
 * container and falls back to the framework default: permanently plugged to
 * AC at 100% (real-device recording: debug.tracing.battery_status=1,
 * charging=1 — oemprop-s3 §battery). A real handset sits between "not
 * fully charged" and "not charging", warm, draining. Apps read all of this
 * through BatteryManager, which honours the BatteryService override layer —
 * so a `dumpsys battery set` override (applied post-boot through the exec
 * seam, re-applied on every boot) covers the entire app-visible surface
 * with ZERO image/boot risk. The `Overrides:` block stays visible in
 * `dumpsys battery` (shell/root only) — accepted for this wave (S1 §3.3).
 *
 * Values are deterministic per device seed (stable across reboots — a phone
 * does not reboot at 100% then 12% then 88%) and re-planned on identity
 * change. WA-STEALTH-FIX2 adds the slow LEVEL drift (batteryDriftLevel —
 * deterministic, watchdog-applied; S1 §6.1 refinement landed).
 */
import { stealthRng } from './device-mac.js';

export const BATTERY_STEALTH_MARKER = 'BATTERY_STEALTH_OK';
export const BATTERY_DRIFT_MARKER = 'BATTERY_DRIFT_OK';
export const BATTERY_READBACK_MARKER = 'BATTERY_READBACK_OK';

const INT = (v, name) => {
  if (!Number.isInteger(v)) throw new Error(`stealth battery: ${name} must be an integer, got ${String(v)}`);
};

/**
 * Deterministic battery profile: level 46..92 (never full, never panic-low),
 * status 3 = discharging (BatteryManager.BATTERY_STATUS_DISCHARGING),
 * temperature 245..355 (tenths of °C — pocket-warm band), voltage
 * 3650..4300 mV loosely consistent with level.
 */
export function buildStealthBatteryProfile({ seed } = {}) {
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('stealth battery: seed required');
  const rng = stealthRng(`vmstealth-battery|${seed}`);
  const level = 46 + Math.floor(rng() * 47); // 46..92
  const temperature = 245 + Math.floor(rng() * 111); // tenths °C
  const voltage = 3600 + Math.round(level * 7 + rng() * 60); // loose consistency
  return { level, status: 3, temperature, voltage };
}

/**
 * The device-side script (exec seam: `sh -c`, same zero-arbitrary-shell rule
 * as the tunnel builders). Fixed argv, integers only — anything non-integer
 * THROWS here, never reaches the device.
 *
 * WA-STEALTH-FIX2 (s1 ruling, D1-4): the SUPPORTED shell surface on the real
 * image is exactly `unplug/reset/status/level/present/ac/usb/wireless/dock`
 * — `set temperature/voltage/health/plug` answer `Unknown set option:`
 * (docs/audits/stealth-fix2/s1/S1-RESEARCH §1). v1 sent temperature+voltage
 * anyway: harmless but silently DROPPED, so the app surface kept
 * voltage=0/temperature=0 — a story-CONSISTENCY tell. v2 therefore applies
 * only supported knobs and adds `present 1` (a real handset reports a
 * battery PRESENT; the container default is present:false). voltage/
 * temperature stay zero on this image = documented KNOWN GAP (root fix =
 * battery HAL, image wave; NOT this layer).
 * @returns {string} sh script ending in the BATTERY_STEALTH_OK marker
 */
export function buildStealthBatteryScript(profile) {
  const { level, status } = profile ?? {};
  INT(level, 'level'); INT(status, 'status');
  if (level < 0 || level > 100) throw new Error(`stealth battery: level out of range: ${level}`);
  if (status < 0 || status > 5) throw new Error(`stealth battery: status out of range: ${status}`);
  return [
    'dumpsys battery unplug',
    `dumpsys battery set status ${status}`,
    `dumpsys battery set level ${level}`,
    'dumpsys battery set present 1',
    'dumpsys battery set ac 0',
    'dumpsys battery set usb 0',
    'dumpsys battery set wireless 0',
    'dumpsys battery set dock 0',
    `echo ${BATTERY_STEALTH_MARKER}`,
  ].join('; ');
}

/**
 * WA-STEALTH-FIX2 (work-order A): slow LEVEL drift so the story is not
 * frozen — a phone that sits at exactly 79% for a week is its own tell.
 * Pure and deterministic: level falls 1% per full `stepMinutes` elapsed
 * since `anchorMs`, clamped at `floorLevel` (never panic-low). No RNG:
 * the value is a function of (profile, clock) only — every recomputation
 * at the same minute agrees, so watchdog ticks never fight.
 * @returns {number} planned level for `nowMs`
 */
export function batteryDriftLevel({ profile, anchorMs, nowMs, stepMinutes = 30, floorLevel = 21 } = {}) {
  const base = Number(profile?.level);
  if (!Number.isInteger(base) || base < 0 || base > 100) throw new Error('stealth battery drift: profile.level required');
  const anchor = Number(anchorMs);
  const now = Number(nowMs);
  const step = Number(stepMinutes);
  const floor = Number(floorLevel);
  if (!Number.isFinite(anchor) || !Number.isFinite(now) || step < 1 || floor < 0 || floor > 100) {
    throw new Error('stealth battery drift: invalid anchor/now/step/floor');
  }
  if (now < anchor) return base; // clock went backwards (NTP) — hold the base
  const steps = Math.floor((now - anchor) / (step * 60_000));
  return Math.max(floor, base - steps);
}

/**
 * Drift tick script (exec seam). Only the supported `level` knob moves —
 * status/present were set at provisioning and live in BatteryService memory
 * until reboot (a reboot re-runs the FULL provisioning, not this).
 * @returns {string} sh script ending in the BATTERY_DRIFT_OK marker
 */
export function buildBatteryDriftScript(level) {
  INT(level, 'level');
  if (level < 0 || level > 100) throw new Error(`stealth battery drift: level out of range: ${level}`);
  return `dumpsys battery set level ${level}; echo ${BATTERY_DRIFT_MARKER}`;
}

/* -----------------------------------------------------------------------
 * WA-RESCAN (S1, 2026-10-30) — battery wipe-race self-healing.
 *
 * The BatteryService override lives ONLY in system-server memory. Any boot
 * event (container restart, framework restart, late boot-flow `dumpsys
 * battery reset`) WIPES the story, and pre-RESCAN the watchdog only moved
 * `level` at a drift-step boundary — so the app surface read the container
 * DEFAULTS (status:1 / present:false / level:0 — measured on fx-2:
 * docs/audits/fix2b/redroid-rdev-fx-2-battery.txt) for up to a full drift
 * step (30 min worst case). The fix: every watchdog tick reads the real
 * device state back and force-REPLAYS the full story (idempotent) whenever
 * the readback diverges. Read values, not assumptions.
 * --------------------------------------------------------------------- */

/**
 * Readback probe script (exec seam, fixed argv). `tr -d '\r'` normalises
 * the CRLF the real device dump carries (same treatment the fx probe driver
 * used: `dumpsys battery | sed -n "s/\r//g"`).
 * @returns {string} sh script ending in the BATTERY_READBACK_OK marker
 */
export function buildBatteryReadbackScript() {
  return `dumpsys battery | tr -d '\\r'; echo ${BATTERY_READBACK_MARKER}`;
}

const lastMatch = (text, re) => {
  let out = null;
  let m;
  const g = new RegExp(re.source, `${re.flags}g`);
  while ((m = g.exec(text)) !== null) out = m;
  return out;
};

/**
 * Parse the app-visible knobs from a `dumpsys battery` dump. LAST occurrence
 * per key wins (the dump can carry a second `UPDATES STOPPED` block with the
 * same keys). Keys on the real image are lowercase (`status: 3`,
 * `present: false`, `level: 0`). Unparseable fields come back null — the
 * caller treats null as "story absent" (needs replay), never as "fine".
 * @returns {{ level: number|null, status: number|null, present: boolean|null }}
 */
export function parseBatteryReadback(stdout) {
  const text = String(stdout ?? '');
  const levelM = lastMatch(text, /(?:^|\n)\s*level:\s*(-?\d+)/);
  const statusM = lastMatch(text, /(?:^|\n)\s*status:\s*(-?\d+)/);
  const presentM = lastMatch(text, /(?:^|\n)\s*present:\s*(true|false)/);
  return {
    level: levelM ? Number(levelM[1]) : null,
    status: statusM ? Number(statusM[1]) : null,
    present: presentM ? presentM[1] === 'true' : null,
  };
}

/**
 * Wipe detection: does the device state match the planned story?
 * Any divergence — wiped defaults, drifted level, unparseable dump — says
 * REPLAY. Replay itself is the idempotent full provisioning script, so this
 * predicate never fights the device: once replayed, it reads back clean.
 * @returns {boolean}
 */
export function batteryStoryNeedsReplay({ profile, plannedLevel, readback } = {}) {
  if (!readback) return true;
  const { level, status, present } = readback;
  if (!Number.isInteger(level) || level !== plannedLevel) return true;
  if (!Number.isInteger(status) || status !== profile?.status) return true;
  if (present !== true) return true;
  return false;
}
