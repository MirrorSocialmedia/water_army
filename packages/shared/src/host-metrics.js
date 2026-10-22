/**
 * host-metrics.js — host memory / CPU-load sampler from /proc (RAM-G1 A2).
 *
 * The gate's admission arithmetic is driven by a FRESH MemAvailable sample
 * at every decision (MD: "fresh /proc/meminfo MemAvailable（帶 timestamp）").
 * This module is the single reader for that sample:
 *
 *   - /proc/meminfo  → MemAvailable / MemTotal / MemFree / Swap* (kB → MiB)
 *   - /proc/loadavg  → load 1/5/15 (display only — the gate never blocks on load)
 *
 * Vantage: inside a docker container (without lxcfs) /proc/meminfo is NOT
 * namespaced — it reports the HOST. That is exactly the vantage the gate
 * wants (verified in G1 A2: container read == host read, same figures).
 *
 * Zero npm dependencies. procDir + readFile are injectable (hermetic tests
 * use fixture files).
 */
import { readFile as fsReadFile } from 'node:fs/promises';

const KB_PER_MIB = 1024;

/** '/proc/meminfo' text → { FieldName: kB } (tolerant: unknown fields kept). */
export function parseMeminfo(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([A-Za-z]+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * @param {object} deps
 * @param {string} [deps.procDir]   '/proc' in production; fixture dir in tests
 * @param {(p:string, enc:string) => Promise<string>} [deps.readFile] injectable reader
 * @param {() => number} [deps.now]  injectable clock (ms)
 */
export function createHostMetrics({ procDir = '/proc', readFile = null, now = () => Date.now() } = {}) {
  const readFileImpl = readFile ?? ((p) => fsReadFile(p, 'utf8'));

  /**
   * One fresh sample. THROWS when MemAvailable cannot be determined —
   * the gate maps that to METRICS_UNAVAILABLE (fail-closed, MD G1).
   * @returns {Promise<{ts:number, memAvailableMiB:number, memTotalMiB:number, memFreeMiB:number, swapTotalMiB:number, swapFreeMiB:number, loadAvg:number[], source:string}>}
   */
  async function sample() {
    let meminfoText;
    let loadavgText = '';
    try {
      meminfoText = await readFileImpl(`${procDir}/meminfo`);
    } catch (err) {
      const e = new Error(`host-metrics: cannot read ${procDir}/meminfo: ${err.message}`);
      e.code = 'METRICS_READ_FAILED';
      throw e;
    }
    try {
      loadavgText = await readFileImpl(`${procDir}/loadavg`);
    } catch {
      /* load is display-only — never fail the sample on it */
    }
    const mi = parseMeminfo(meminfoText);
    if (!Number.isFinite(mi.MemAvailable)) {
      const e = new Error('host-metrics: MemAvailable missing from /proc/meminfo');
      e.code = 'METRICS_PARSE_FAILED';
      throw e;
    }
    const toMiB = (kb) => (Number.isFinite(kb) ? Math.round((kb / KB_PER_MIB) * 10) / 10 : null);
    const loadParts = String(loadavgText).trim() === '' ? [] : String(loadavgText).split(/\s+/).map(Number);
    return {
      ts: now(),
      memAvailableMiB: toMiB(mi.MemAvailable),
      memTotalMiB: toMiB(mi.MemTotal),
      memFreeMiB: toMiB(mi.MemFree),
      swapTotalMiB: toMiB(mi.SwapTotal),
      swapFreeMiB: toMiB(mi.SwapFree),
      loadAvg: [loadParts[0] ?? null, loadParts[1] ?? null, loadParts[2] ?? null],
      source: 'proc-meminfo',
    };
  }

  return { sample };
}
