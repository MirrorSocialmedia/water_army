/**
 * L2 wave-2 (ADR-033) — per-identity /proc view + display geometry ("deviceSpec").
 *
 * Problem (exposure-surfaces D10/D11/B2, D7/B6, appendix A measured):
 * the container leaks the HOST into every consumer's hardware story —
 * /proc/meminfo shows the host RAM, /proc/cpuinfo shows the host x86 CPU,
 * navigator.hardwareConcurrency/deviceMemory ride the same host values, and
 * the whole fleet shares one 720x1280 virtual display regardless of which
 * phone model the fingerprint profile claims. Browser-side JS cross-checks
 * these against the ro.* build story in one page load (B7).
 *
 * This module is the mechanism layer for wave 2 (code segment — real-device
 * mount/geometry verification is the next batch):
 *  1. `deviceSpec` — the template/profile metadata carrying the device's real
 *     display geometry and the fake /proc story (cores, cluster topology,
 *     MemTotal). Same discipline as hardware (ADR-031): REQUIRED on build
 *     templates, OPTIONAL on legacy stored profiles (they degrade to the
 *     image default instead of failing).
 *  2. Deterministic fake-file renderers (renderMeminfoText/renderCpuinfoText)
 *     — host-testable renderers whose on-device twins live in
 *     images/redroid-w1b/oem-proc-view.sh (same output contract, asserted
 *     by images/redroid-w1b/test/test-proc-view.sh).
 *  3. The carrier contract: three compact androidboot.oem_* args
 *     (mem_total_kb / cpu_cores / cpu_clusters) ride the SAME docker-Cmd
 *     carrier as the identity ro.* props; an init post-fs-data hook runs
 *     oem-proc-view.sh which renders + bind-mounts over /proc/meminfo and
 *     /proc/cpuinfo. Route decision (vs lxcfs host daemon vs baked files):
 *     W1b carrier pattern — per-identity, platform-side, no host daemon,
 *     image stays fleet-identical (single source = the profile).
 *  4. Display application point: androidboot.redroid_width/height/dpi are
 *     container START ARGS (redroid-doc official method, already the repo's
 *     own MD §2.1 rule) — deviceDisplayArgs() feeds them at create time.
 *     Runtime `wm size/density` is the OBSERVATION surface, never the write
 *     surface: an override set at runtime persists in settings and would
 *     out-rank the boot args on the next start (real-device checklist item).
 *
 * Known limits (documented, honest):
 *  - Static bind-mounted /proc files are SNAPSHOTS: MemAvailable/MemFree
 *    never move on-device while a real device drifts. Better than leaking
 *    92GB, but "never-changing meminfo" is itself a (weak) tell — logged
 *    for the real-device stage.
 *  - navigator.hardwareConcurrency reads sched_getaffinity/sysconf, NOT
 *    /proc/cpuinfo — the /proc fix covers file readers (apps, shell);
 *    Chrome's core count needs a cpuset placement constraint (platform
 *    scheduler work, contract: profileProcCpuCores(profile) below).
 *  - deviceMemory (GB) is derived by Chrome from host RAM: once meminfo +
 *    cpuset story is in place the value follows, but the quantisation is
 *    Chrome-internal — cross-assert, don't assume (web probe).
 */

// ---------------------------------------------------------------------------
// deviceSpec shape + validation
// ---------------------------------------------------------------------------

/**
 * deviceSpec = { display: {widthPx, heightPx, densityDpi, refreshHz},
 *                proc:    {cpuCores, cpuClusters: [{count, part, implementer?, variant?, revision?, bogoMips?}], memTotalKb} }
 * display: REAL panel geometry for the claimed model (template fact, verbatim).
 * proc.memTotalKb is per-identity (jittered at generation) so the fake
 * MemTotal is not one fleet-wide constant; clusters model the SoC's real
 * big.LITTLE topology (ARM core TRM part ids).
 */
export function validateDeviceSpec(spec, label = 'deviceSpec') {
  const problems = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return [`${label} must be a plain object`];
  const d = spec.display;
  if (!d || typeof d !== 'object' || Array.isArray(d)) problems.push(`${label}.display must be a plain object`);
  else {
    // same bounds as redroid-service checkDim (create-time validation parity)
    intField(problems, d, 'widthPx', 160, 8192, `${label}.display`);
    intField(problems, d, 'heightPx', 160, 8192, `${label}.display`);
    intField(problems, d, 'densityDpi', 100, 1200, `${label}.display`);
    intField(problems, d, 'refreshHz', 1, 240, `${label}.display`);
  }
  const p = spec.proc;
  if (!p || typeof p !== 'object' || Array.isArray(p)) problems.push(`${label}.proc must be a plain object`);
  else {
    intField(problems, p, 'cpuCores', 1, 256, `${label}.proc`);
    // proc RAM has TWO shapes: template rows carry the nominal marketing
    // figure (memTotalMb — the per-identity kernel reserve is applied at
    // generation), generated profiles carry the final fake MemTotal (memTotalKb).
    const hasKb = p.memTotalKb !== undefined;
    const hasMb = p.memTotalMb !== undefined;
    if (hasKb && hasMb) problems.push(`${label}.proc: memTotalKb and memTotalMb are mutually exclusive`);
    else if (hasKb) intField(problems, p, 'memTotalKb', 131072, 33554432, `${label}.proc`); // 128MB..32TB
    else if (hasMb) intField(problems, p, 'memTotalMb', 128, 32768, `${label}.proc`); // 128MB..32GB nominal
    else problems.push(`${label}.proc requires memTotalKb (profile form) or memTotalMb (template form)`);
    const cl = p.cpuClusters;
    // VACUOUS GUARD: a missing/empty cluster list is invalid — cpuinfo would
    // render zero cores and every "cores > 0" assertion would pass vacuously.
    if (!Array.isArray(cl) || cl.length === 0) problems.push(`${label}.proc.cpuClusters must be a non-empty array`);
    else {
      let sum = 0;
      cl.forEach((c, i) => {
        if (!c || typeof c !== 'object') { problems.push(`${label}.proc.cpuClusters[${i}] must be an object`); return; }
        if (!Number.isInteger(c.count) || c.count < 1 || c.count > 256) problems.push(`${label}.proc.cpuClusters[${i}].count must be 1..256`);
        else sum += c.count;
        if (typeof c.part !== 'string' || !/^0x[0-9a-f]{3,4}$/.test(c.part)) problems.push(`${label}.proc.cpuClusters[${i}].part must be an ARM part id like 0xd4e`);
        for (const k of ['implementer', 'variant', 'revision']) {
          if (c[k] !== undefined && (typeof c[k] !== 'string' || !/^0x[0-9a-f]{1,4}$/.test(c[k]))) problems.push(`${label}.proc.cpuClusters[${i}].${k} must be a hex string like 0x41`);
        }
        if (c.bogoMips !== undefined && (typeof c.bogoMips !== 'string' || !/^\d{1,4}(\.\d{1,2})?$/.test(c.bogoMips))) problems.push(`${label}.proc.cpuClusters[${i}].bogoMips must look like 66.66`);
      });
      if (Number.isInteger(p.cpuCores) && sum > 0 && sum !== p.cpuCores) problems.push(`${label}.proc.cpuClusters sum ${sum} != cpuCores ${p.cpuCores}`);
    }
  }
  return problems;
}

function intField(problems, obj, key, min, max, label) {
  const v = obj[key];
  if (!Number.isInteger(v)) problems.push(`${label}.${key} must be an integer`);
  else if (v < min || v > max) problems.push(`${label}.${key} ${v} out of range ${min}..${max}`);
}

/**
 * Kernel-reserve model for per-identity MemTotal: nominal marketing RAM
 * minus the 3.5–9.5% a real kernel withholds from MemTotal (kernel image,
 * CMA/GPU carveouts, memmeta). Spread keeps the fleet off one constant;
 * determinism keeps recreate stable (rng stream consumed LAST in the
 * generators so pre-existing fields never shift — drift discipline).
 * Real-device capture will pin per-model reserves (checklist item).
 */
export function memTotalKbForIdentity(rng, memTotalMb) {
  if (!Number.isInteger(memTotalMb) || memTotalMb < 128 || memTotalMb > 32768) throw new Error('memTotalKbForIdentity: memTotalMb must be 128..32768 MB');
  const r = rng.u32();
  const reserve = 0.035 + (r % 61) / 1000; // 3.5%..9.5%
  return Math.round(memTotalMb * 1024 * (1 - reserve));
}

/**
 * Generic real-phone deviceSpec pool for the W1 SYNTHETIC generator (the
 * template-backed path uses per-model REAL specs from the data file).
 * Part ids per ARM core TRMs; geometry/density combos are shipping-class.
 */
export const SYNTHETIC_DEVICE_SPECS = Object.freeze([
  Object.freeze({
    display: Object.freeze({ widthPx: 1080, heightPx: 2340, densityDpi: 395, refreshHz: 90 }),
    proc: Object.freeze({ cpuCores: 8, memTotalMb: 8192, cpuClusters: [
      Object.freeze({ count: 2, part: '0xd09' }), Object.freeze({ count: 6, part: '0xd05' }),
    ] }),
  }),
  Object.freeze({
    display: Object.freeze({ widthPx: 1080, heightPx: 2400, densityDpi: 420, refreshHz: 120 }),
    proc: Object.freeze({ cpuCores: 8, memTotalMb: 8192, cpuClusters: [
      Object.freeze({ count: 1, part: '0xd48' }), Object.freeze({ count: 3, part: '0xd47' }), Object.freeze({ count: 4, part: '0xd46' }),
    ] }),
  }),
  Object.freeze({
    display: Object.freeze({ widthPx: 1440, heightPx: 3200, densityDpi: 525, refreshHz: 120 }),
    proc: Object.freeze({ cpuCores: 8, memTotalMb: 12288, cpuClusters: [
      Object.freeze({ count: 1, part: '0xd4e' }), Object.freeze({ count: 3, part: '0xd4d' }), Object.freeze({ count: 4, part: '0xd86' }),
    ] }),
  }),
  Object.freeze({
    display: Object.freeze({ widthPx: 1080, heightPx: 2400, densityDpi: 400, refreshHz: 60 }),
    proc: Object.freeze({ cpuCores: 8, memTotalMb: 6144, cpuClusters: [
      Object.freeze({ count: 4, part: '0xd08' }), Object.freeze({ count: 4, part: '0xd05' }),
    ] }),
  }),
]);

// ---------------------------------------------------------------------------
// Carrier contract (androidboot Cmd args — SAME carrier as identity ro.*)
// ---------------------------------------------------------------------------

/**
 * Carrier keys. Deliberately NOT routed through PROFILE_PROP_MAP: these are
 * not props — they render /proc FILES via the init script, so they never
 * appear in the rc mapping table or getprop output.
 * Cluster encoding: "count:impl:part:variant:revision:bogo" per cluster,
 * comma-joined — every char survives SAFE_PROFILE_VALUE_RE-class cmdline
 * transport (no spaces/'='/'%' — same family rule as the ro.* carriers).
 */
export const PROC_CARRIER_KEYS = Object.freeze({
  memTotalKb: 'androidboot.oem_mem_total_kb',
  cpuCores: 'androidboot.oem_cpu_cores',
  cpuClusters: 'androidboot.oem_cpu_clusters',
});

/** Device-side ro.boot.* view of the carriers (what the script getprops). */
export const PROC_CARRIER_RO_KEYS = Object.freeze({
  memTotalKb: 'ro.boot.oem_mem_total_kb',
  cpuCores: 'ro.boot.oem_cpu_cores',
  cpuClusters: 'ro.boot.oem_cpu_clusters',
});

export function encodeClusters(clusters) {
  return clusters
    .map((c) => [c.count, c.implementer ?? '0x41', c.part, c.variant ?? '0x0', c.revision ?? '0x0', c.bogoMips ?? '66.66'].join(':'))
    .join(',');
}

/**
 * The three Cmd args for one profile's proc view. ALL-OR-NONE: partial
 * carriers would render a half-fake /proc (script refuses on-device too —
 * fail closed at both ends). Returns [] when the profile carries no proc
 * story (legacy row → image default, correct degradation).
 */
export function procViewCmdArgs(proc) {
  if (proc === undefined || proc === null) return [];
  const problems = validateDeviceSpec({ display: { widthPx: 160, heightPx: 160, densityDpi: 100, refreshHz: 60 }, proc }, 'procViewCmdArgs');
  if (problems.length) throw new Error(`procViewCmdArgs: invalid proc spec: ${problems.join('; ')}`);
  return [
    `${PROC_CARRIER_KEYS.memTotalKb}=${proc.memTotalKb}`,
    `${PROC_CARRIER_KEYS.cpuCores}=${proc.cpuCores}`,
    `${PROC_CARRIER_KEYS.cpuClusters}=${encodeClusters(proc.cpuClusters)}`,
  ]; // fixed key order (mem, cores, clusters) — stable for snapshots
}

/** Convenience for the create path: [] when the profile predates wave 2. */
export function profileProcCmdArgs(profile) {
  const proc = profile?.deviceSpec?.proc;
  return proc ? procViewCmdArgs(proc) : [];
}

/** cpu count for the container placement constraint (cpuset / hardwareConcurrency story). */
export function profileProcCpuCores(profile) {
  const n = profile?.deviceSpec?.proc?.cpuCores;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Fake-file renderers (pure; the on-device script mirrors this contract)
// ---------------------------------------------------------------------------

/**
 * Kernel-style key/value padding ("MemTotal:" + column-aligned kB value).
 * Real /proc/meminfo pads the label to 13 chars then right-aligns the value.
 */
function memLine(label, kb) {
  return `${label}:`.padEnd(14) + String(kb).padStart(8) + ' kB';
}

/**
 * Deterministic fake /proc/meminfo. Values derive from memTotalKb only
 * (same seed value → identical bytes). Fractions carry a small spread
 * derived from the value itself so different identities do not render
 * identical second-order lines either.
 */
export function renderMeminfoText({ memTotalKb } = {}) {
  if (!Number.isInteger(memTotalKb) || memTotalKb < 131072) throw new Error('renderMeminfoText: memTotalKb must be an integer >= 131072');
  const t = memTotalKb;
  // small deterministic integer hash of t drives second-order spread, so
  // different identities never render byte-identical auxiliary lines either
  const h = (Math.imul(t, 1103515245) + 12345) >>> 0;
  const memFree = Math.round(t * (0.24 + (h % 81) / 1000));            // 24.0..32.0%
  const cachedKb = Math.round(t * (0.28 + ((h >>> 7) % 121) / 1000));   // 28.0..40.0%
  const available = Math.min(t - 1, memFree + Math.round(cachedKb * 0.62));
  const lines = [
    memLine('MemTotal', t),
    memLine('MemFree', memFree),
    memLine('Buffers', Math.round(t * 0.008) + (t % 97)),
    memLine('Cached', cachedKb),
    memLine('SwapCached', t % 313),
    memLine('Active', Math.round(t * 0.31)),
    memLine('Inactive', Math.round(t * 0.19)),
    memLine('Active(anon)', Math.round(t * 0.13)),
    memLine('Inactive(anon)', Math.round(t * 0.06)),
    memLine('Active(file)', Math.round(t * 0.18)),
    memLine('Inactive(file)', Math.round(t * 0.13)),
    memLine('Unevictable', t % 4096),
    memLine('Dirty', t % 20480),
    memLine('Writeback', 0),
    memLine('AnonPages', Math.round(t * 0.14)),
    memLine('Mapped', Math.round(t * 0.09)),
    memLine('Shmem', Math.round(t * 0.02)),
    memLine('KReclaimable', Math.round(t * 0.011)),
    memLine('Slab', Math.round(t * 0.03)),
    memLine('SReclaimable', Math.round(t * 0.011)),
    memLine('SUnreclaim', Math.round(t * 0.019)),
    memLine('KernelStack', 8192 + (t % 2048)),
    memLine('PageTables', Math.round(t * 0.007)),
    memLine('NFS_Unstable', 0),
    memLine('Bounce', 0),
    memLine('WritebackTmp', 0),
    memLine('CommitLimit', Math.round(t * 0.75)),
    memLine('Committed_AS', Math.round(t * 0.42)),
    memLine('VmallocTotal', 262972557312),
    memLine('VmallocUsed', 163840 + (t % 8192)),
    memLine('Percpu', 4096),
    'HardwareError:         0 kB',
    memLine('HugePages_Total', 0),
    memLine('HugePages_Free', 0),
    memLine('HugePages_Rsvd', 0),
    memLine('HugePages_Surp', 0),
    'Hugepagesize:       2048 kB',
    memLine('Hugetlb', 0),
  ];
  return lines.map((l) => l + '\n').join('');
}

const CPUINFO_FEATURES = 'fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 asimdfhm dit uscat ilrcpc flagm ssbs paca pacp';

/**
 * Deterministic fake /proc/cpuinfo in ARM64 shape (kernel arch/arm64 format:
 * NO "model name"/"Hardware" lines — those are x86/arm32 artifacts; an ARM64
 * cpuinfo with "model name : AMD Ryzen..." would be WORSE than the leak).
 * cores = cluster expansion, prime first (matches lscpu/topology order).
 */
export function renderCpuinfoText({ cpuCores, cpuClusters } = {}) {
  if (!Number.isInteger(cpuCores) || cpuCores < 1 || cpuCores > 256) throw new Error('renderCpuinfoText: cpuCores must be 1..256');
  if (!Array.isArray(cpuClusters) || cpuClusters.length === 0) throw new Error('renderCpuinfoText: cpuClusters must be a non-empty array');
  let core = 0;
  let out = '';
  for (const cl of cpuClusters) {
    for (let i = 0; i < cl.count; i++, core++) {
      out += `processor\t: ${core}\n`;
      out += `BogoMIPS\t: ${cl.bogoMips ?? '66.66'}\n`;
      out += `Features\t: ${CPUINFO_FEATURES}\n`;
      out += `CPU implementer\t: ${cl.implementer ?? '0x41'}\n`;
      out += 'CPU architecture: 8\n';
      out += `CPU variant\t: ${cl.variant ?? '0x0'}\n`;
      out += `CPU part\t: ${cl.part}\n`;
      out += `CPU revision\t: ${cl.revision ?? '0x0'}\n`;
      out += '\n';
    }
  }
  if (core !== cpuCores) throw new Error(`renderCpuinfoText: cluster expansion rendered ${core} cores != cpuCores ${cpuCores}`);
  return out;
}

// ---------------------------------------------------------------------------
// init hook contract (image side) — GENERATED rc, drift-diffed like wave 1
// ---------------------------------------------------------------------------

/** Path the render+mount script is baked to inside the image. */
export const PROC_VIEW_SCRIPT_BIN = '/vendor/bin/oem-proc-view.sh';

/**
 * The rc artifact for the /proc view. ONE trigger (mem_total carrier = the
 * all-or-none sentinel, the script re-checks every carrier itself). Phase =
 * post-fs-data: shell/init helpers are not available at early-init in this
 * image (APEX linker mounts at early-fs — same constraint ADR-031 hit), and
 * post-fs-data still runs strictly before zygote, so no process ever maps
 * the real meminfo into its address space first. /proc is mounted since
 * first-stage init, so a post-fs-data bind-mount shadows it for everything
 * that starts afterwards.
 */
export function generateProcViewRc() {
  return [
    '# water_army L2 wave-2 — /proc view spoof (GENERATED — do not hand-edit)',
    '# regenerate: node scripts/w1b/generate-wa-ro-map-rc.mjs (writes BOTH rc files)',
    '# source of truth: packages/shared/src/device-spec.js (unit-diffed in CI)',
    '#',
    '# post-fs-data: render per-identity fake /proc/meminfo + /proc/cpuinfo from',
    '# the androidboot.oem_mem_* carriers and bind-mount them over the host-',
    '# penetrating originals (D10/D11: containers share the host kernel view —',
    '# appendix A measured host RAM/x86 CPU names straight through). The script',
    '# is self-guarded: absent carriers = exit 0, image default untouched.',
    '',
    `on post-fs-data && property:${PROC_CARRIER_RO_KEYS.memTotalKb}=*`,
    `    exec -- ${PROC_VIEW_SCRIPT_BIN}`,
    '',
  ].join('\n');
}

/** Parse the proc-view rc back (drift check). */
export function parseProcViewRc(text) {
  const problems = [];
  const lines = String(text ?? '').split('\n');
  let trig = null;
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^on (early-init|post-fs-data|fs|onboot) && property:([A-Za-z0-9_.]+)=\*$/);
    if (m) {
      if (trig) problems.push(`line ${i}: trigger without matching exec`);
      if (m[1] !== 'post-fs-data') problems.push(`line ${i}: phase ${m[1]} must be post-fs-data (shell unavailable earlier, zygote starts later)`);
      if (m[2] !== PROC_CARRIER_RO_KEYS.memTotalKb) problems.push(`line ${i}: carrier ${m[2]} unexpected`);
      trig = m[2];
      continue;
    }
    const e = line.match(/^ {4}exec -- \/vendor\/bin\/oem-proc-view\.sh$/);
    if (e) {
      if (!trig) { problems.push(`line ${i}: exec without trigger`); continue; }
      trig = null;
      continue;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    problems.push(`line ${i}: unexpected rc content "${line.slice(0, 60)}"`);
  }
  if (trig) problems.push('dangling trigger without exec');
  return { problems };
}

// ---------------------------------------------------------------------------
// Display application point + web cross-assertion math
// ---------------------------------------------------------------------------

/**
 * Container START ARGS for the profile's display geometry (redroid-doc
 * official knobs, already the repo's Cmd discipline — MD §2.1). Returns
 * {width, height, dpi} validated against the same bounds redroid-service
 * checkDim enforces, or null for legacy profiles (→ template default).
 * fps/refresh are deliberately NOT overridden: redroid_fps drives the
 * software-rendering cadence (CPU cost under swiftshader) and refreshHz is
 * invisible to the web probes we assert against — documented non-goal.
 */
export function deviceDisplayArgs(profile) {
  const d = profile?.deviceSpec?.display;
  if (!d) return null;
  const problems = validateDeviceSpec({ display: d, proc: { cpuCores: 1, memTotalKb: 131072, cpuClusters: [{ count: 1, part: '0xd05' }] } }, 'deviceDisplayArgs');
  if (problems.length) throw new Error(`deviceDisplayArgs: invalid display spec: ${problems.join('; ')}`);
  return { width: d.widthPx, height: d.heightPx, dpi: d.densityDpi };
}

/**
 * Expected web geometry for the identity story: Android Chromium reports
 * devicePixelRatio = densityDpi/160 [docs: Chromium wm density ↔ dpr],
 * screen.width/height are CSS px. Rounding at odd densities is browser-
 * side detail — the probe assertion compares with tolerance 2 css px
 * (approximate = honest; exact values land in the real-device capture).
 */
export function expectedWebGeometry(profile) {
  const d = profile?.deviceSpec?.display;
  if (!d) return null;
  const dpr = d.densityDpi / 160;
  return {
    dpr,
    cssWidthPx: Math.round(d.widthPx / dpr),
    cssHeightPx: Math.round(d.heightPx / dpr),
    physicalWidthPx: d.widthPx,
    physicalHeightPx: d.heightPx,
    toleranceCssPx: 2,
  };
}

// ---------------------------------------------------------------------------
// Consistency kernel (platform probe-dump side)
// ---------------------------------------------------------------------------

/**
 * Assert a probe dump's deviceSpec section against the stored profile.
 * observed.dumpSpec shape = { display: {widthPx?, heightPx?, densityDpi?},
 * proc: {memTotalKb?, cpuinfoCores?} } — populated by the probe app / shell
 * harness at the real-device stage (reads render markers, /proc files).
 *
 * Anti-vacuous rule (wave-1 discipline): when the profile carries a
 * deviceSpec, the dump MUST carry the matching observations — a missing
 * observation is MISSING (blocking), never a silent pass. Profiles without
 * deviceSpec (legacy rows) SKIP (non-blocking degradation).
 *
 * @returns {{rows: Array<{key: string, expected: unknown, observed: unknown, status: 'PASS'|'FAIL'|'MISSING'|'SKIP'}>, pass: boolean}}
 */
export function checkDeviceSpecConsistency(expectedProfile, dumpSpec) {
  const rows = [];
  const want = expectedProfile?.deviceSpec;
  if (!want) {
    return { rows: [{ key: 'deviceSpec', expected: null, observed: null, status: 'SKIP' }], pass: true };
  }
  const obs = dumpSpec && typeof dumpSpec === 'object' ? dumpSpec : null;
  const push = (key, exp, got) => {
    let status;
    if (got === undefined || got === null) status = 'MISSING';
    else status = String(got) === String(exp) ? 'PASS' : 'FAIL';
    rows.push({ key, expected: exp, observed: got ?? null, status });
  };
  if (want.display) {
    push('display.widthPx', want.display.widthPx, obs?.display?.widthPx);
    push('display.heightPx', want.display.heightPx, obs?.display?.heightPx);
    push('display.densityDpi', want.display.densityDpi, obs?.display?.densityDpi);
  }
  if (want.proc) {
    push('proc.memTotalKb', want.proc.memTotalKb, obs?.proc?.memTotalKb);
    push('proc.cpuCores', want.proc.cpuCores, obs?.proc?.cpuinfoCores);
  }
  return { rows, pass: rows.every((r) => r.status === 'PASS') };
}

/**
 * Resolve display geometry for the create path with the ADR-033 precedence:
 * explicit create override > profile deviceSpec > platform template default.
 * Pure; caller keeps its own validation of the o.* side.
 */
export function resolveDisplayDims({ overrideWidth, overrideHeight, overrideDpi, profile, template }) {
  const spec = deviceDisplayArgs(profile); // throws on invalid spec (fail closed)
  return {
    width: overrideWidth ?? spec?.width ?? template.width,
    height: overrideHeight ?? spec?.height ?? template.height,
    dpi: overrideDpi ?? spec?.dpi ?? template.dpi,
    fromProfile: spec ? !!(overrideWidth == null && overrideHeight == null) : false,
  };
}
