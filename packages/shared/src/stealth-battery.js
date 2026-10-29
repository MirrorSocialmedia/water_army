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
 * change. Slow level drift over time is a FINAL refinement (S1 §6.1).
 */
import { stealthRng } from './device-mac.js';

export const BATTERY_STEALTH_MARKER = 'BATTERY_STEALTH_OK';

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
 * @returns {string} sh script ending in the BATTERY_STEALTH_OK marker
 */
export function buildStealthBatteryScript(profile) {
  const { level, status, temperature, voltage } = profile ?? {};
  INT(level, 'level'); INT(status, 'status'); INT(temperature, 'temperature'); INT(voltage, 'voltage');
  if (level < 0 || level > 100) throw new Error(`stealth battery: level out of range: ${level}`);
  if (status < 0 || status > 5) throw new Error(`stealth battery: status out of range: ${status}`);
  if (temperature < 0 || temperature > 600) throw new Error(`stealth battery: temperature out of range: ${temperature}`);
  if (voltage < 0 || voltage > 20000) throw new Error(`stealth battery: voltage out of range: ${voltage}`);
  return [
    'dumpsys battery unplug',
    `dumpsys battery set status ${status}`,
    `dumpsys battery set level ${level}`,
    `dumpsys battery set temperature ${temperature}`,
    `dumpsys battery set voltage ${voltage}`,
    `dumpsys battery set ac 0`,
    `dumpsys battery set usb 0`,
    `dumpsys battery set wireless 0`,
    `echo ${BATTERY_STEALTH_MARKER}`,
  ].join('; ');
}
