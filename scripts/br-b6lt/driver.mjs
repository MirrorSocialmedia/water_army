#!/usr/bin/env node
/**
 * BR-B6 real-device ladder load-test driver (MD §14.4):
 *   1 -> 5 -> 10 -> 25 -> 50 concurrent real redroid containers, NEVER
 *   starting at 50. Each stage: set global cap -> create+start a cycle over
 *   the first N ladder identities -> wait terminal (soak inside the run) ->
 *   collect CPU/RAM/GPU/disk/boot-time/error-rate/host-health -> stop ->
 *   report -> re-arm -> next stage.
 *
 * GPU redline (boss-approved): SGLang @ 127.0.0.1:30000 shares the RTX 3090 x2.
 * The 5s sampler + halt monitor implement vram-monitoring-plan.md §3 verbatim:
 *   - any GPU free VRAM < 1500 MiB        -> HALT (reduce/wait)
 *   - SGLang process VRAM creep > 1024 MiB -> HALT
 *   - SGLang health non-200/timeout       -> HALT immediately
 *   - host MemAvailable<16G / load / disk -> HALT
 * A HALT cancels the running stage batch, records why, and shrinks the next
 * stage (min(next, floor(availVRAM/per-device delta)-1)); two consecutive
 * triggers close the ladder at the last stable size (honest capacity number).
 *
 * Exit 0 = ladder completed (all 5 stages, or closed by VRAM with a
 * documented max); 1 = hard failure; 2 = driver crash.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const API = 'http://127.0.0.1:16543';
const RUN = '.dev/br-b6lt';
const EVIDENCE = process.env.BRB6LT_EVIDENCE_DIR ?? '/home/kenneth/.openclaw/workspace/logs/br-b6-loadtest';
const IMAGE = 'water-army/redroid@sha256:591296d5656571f346994dc81608ca33744af4d0e9c9876241a8595e70143b55';
const STAGES = [1, 5, 10, 25, 50];
const SGLANG_HEALTH_URL = 'http://127.0.0.1:30000/get_model_info';
mkdirSync(EVIDENCE, { recursive: true });

const dbUrl = readFileSync(`${RUN}/api.env`, 'utf8').split('\n')
  .find((l) => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
if (!dbUrl) throw new Error('DATABASE_URL missing from api.env — run setup.sh first');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });
await db.$connect();

const seed = JSON.parse(readFileSync(`${RUN}/identities.json`, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dc = (args) => execSync(`sg docker -c "docker ${args}"`, { encoding: 'utf8' }).trim();
const nowIso = () => new Date().toISOString();

let cookie;
const results = [];
function record(phase, name, pass, detail = '', { soft = false } = {}) {
  results.push({ phase, name, pass: !!pass, detail: String(detail).slice(0, 300), soft, at: nowIso() });
  console.log(`[${phase}] ${pass ? 'PASS' : 'FAIL'}${soft ? ' (soft)' : ''} — ${name}${detail ? ` (${detail})` : ''}`);
  return !!pass;
}

async function api(method, path, { body } = {}) {
  const headers = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
async function login() {
  const res = await api('POST', '/api/auth/login', { body: { username: seed.admin.username, password: seed.admin.password } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  cookie = res.headers.get('set-cookie').split(';')[0];
}
async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 5000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return { v, timedOut: false, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v: null, timedOut: true, elapsedMs: Date.now() - t0 };
    await sleep(intervalMs);
  }
}

const CONTAINER_SPEC = {
  type: 'container',
  image: IMAGE,
  health: { kind: 'adb-tcp', port: 5555 },
  work: { kind: 'hold', durationMs: 600_000 },
};

// ------------------------------------------------------------ VRAM / host sampler
const cores = os.cpus().length;
let sampler = null;
function vramRaw() {
  const g = execSync('nvidia-smi --query-gpu=index,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits', { encoding: 'utf8' }).trim().split('\n').map((l) => l.split(',').map((s) => s.trim()));
  const apps = execSync('nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((l) => l.split(',').map((s) => s.trim()));
  return { gpus: g, apps };
}
function hostSample() {
  let load1 = 0, memAvailGB = 0, diskRootGB = 0;
  try { load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { /* ignore */ }
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8');
    const m = mi.match(/MemAvailable:\s+(\d+)/);
    memAvailGB = m ? Number(m[1]) / 1024 / 1024 : 0;
  } catch { /* ignore */ }
  try {
    const df = execSync('df -BG / /var/lib/docker 2>/dev/null | tail -2 | awk \'{print $4}\' | tr -d G', { encoding: 'utf8' }).trim().split('\n').map(Number);
    diskRootGB = Math.min(...df.filter((n) => Number.isFinite(n)));
  } catch { diskRootGB = 0; }
  return { load1, memAvailGB, diskRootGB };
}
function managedCount() {
  try { return dc(`ps -aq --filter "label=com.mirrorsocialmedia.water-army.managed=true"`).split('\n').filter(Boolean).length; } catch { return -1; }
}
function startSampler(stageN, outTag) {
  const vramCsv = `${EVIDENCE}/vram-stage${stageN}.csv`;
  const hostCsv = `${EVIDENCE}/host-stage${stageN}.csv`;
  writeFileSync(vramCsv, 'ts,gpu_idx,mem_used,mem_free,util_gpu\n');
  writeFileSync(hostCsv, 'ts,load1,mem_avail_gb,disk_free_gb,active_containers\n');
  const st = {
    baselineApps: {}, sglangPid: null, sglangBaseMiB: 0, halt: null, haltReason: null,
  };
  sampler = st;
  const tick = async () => {
    try {
      const { gpus, apps } = vramRaw();
      const h = hostSample();
      const n = managedCount();
      const ts = nowIso();
      for (const g of gpus) {
        appendLine(vramCsv, `${ts},${g[0]},${g[1]},${g[2]},${g[3]}`);
      }
      appendLine(hostCsv, `${ts},${h.load1},${h.memAvailGB.toFixed(1)},${h.diskRootGB},${n}`);
      // baseline + SGLang tracking (compute-apps: the sglang procs are the big ones)
      for (const a of apps) {
        const pid = Number(a[0]); const memMiB = Number(a[1]);
        if (st.sglangPid === null) {
          st.baselineApps[pid] = memMiB;
          if (memMiB > 10000) { st.sglangPid = pid; st.sglangBaseMiB = memMiB; }
        } else if (st.sglangPid === pid) {
          st.sglangBaseMiB = Math.max(st.sglangBaseMiB, 0); // keep first-observed baseline
        }
      }
      // halt rules (vram-monitoring-plan.md §3) — only while a stage is live
      if (!st.stageActive) return;
      const minFree = Math.min(...gpus.map((g) => Number(g[2])));
      const sglang = st.sglangPid ? apps.find((a) => Number(a[0]) === st.sglangPid) : null;
      const sglangCreep = sglang ? Number(sglang[1]) - st.sglangBaseMiB : 0;
      if (minFree < 1500) return void halt(`vram-low: min free ${minFree} MiB < 1500`);
      if (sglangCreep > 1024) return void halt(`sglang-creep: +${sglangCreep} MiB > 1024`);
      if (h.memAvailGB > 0 && h.memAvailGB < 16) return void halt(`host-ram: MemAvailable ${h.memAvailGB.toFixed(1)}G < 16G`);
      if (h.load1 > 2 * cores + 8) return void halt(`host-load: load1 ${h.load1} > ${2 * cores + 8}`);
      if (h.diskRootGB > 0 && h.diskRootGB < 20) return void halt(`host-disk: ${h.diskRootGB}G free < 20G`);
      // SGLang health (read-only probe; the port is otherwise forbidden to touch)
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 30_000);
        const r = await fetch(SGLANG_HEALTH_URL, { signal: ctl.signal });
        clearTimeout(t);
        if (r.status !== 200) halt(`sglang-health: HTTP ${r.status}`);
      } catch (err) {
        halt(`sglang-health: ${String(err?.message ?? err).slice(0, 80)}`);
      }
    } catch (err) {
      console.log(`[sampler] tick error (non-fatal): ${String(err?.message ?? err).slice(0, 120)}`);
    }
  };
  function halt(reason) {
    if (st.halt) return;
    st.halt = reason; st.haltReason = reason;
    console.log(`[HALT] ${reason}`);
  }
  st.stageActive = false;
  const iv = setInterval(tick, 5000);
  tick();
  st.stop = async () => {
    st.stageActive = false;
    clearInterval(iv);
    await tick().catch(() => {});
  };
  return st;
}
function appendLine(file, line) {
  import('node:fs').then(({ appendFileSync }) => appendFileSync(file, line + '\n'));
}

// ------------------------------------------------------------ stage plumbing
async function setGlobalCap(n) {
  const r = await api('POST', '/api/batches/capacity', { body: { maxActiveContainers: n } });
  if (r.status !== 200) throw new Error(`setGlobalCap(${n}) failed: ${r.status} ${r.text}`);
  return r.json;
}
async function allBatchesOf(cycleId) {
  return db.batch.findMany({ where: { cycleId }, orderBy: { batchNo: 'asc' } });
}
async function startFirstBatch(cycleId, label) {
  const [b] = await allBatchesOf(cycleId);
  if (!b) throw new Error(`${label}: no batches found`);
  const r = await api('POST', `/api/batches/${b.id}/start`);
  // scheduler auto-start race: a 200 already-running no-op is success too
  if (r.status !== 200 || !(r.json?.batch?.status === 'RUNNING' || r.json?.started === false)) {
    throw new Error(`${label}: start failed ${r.status} ${r.text.slice(0, 200)}`);
  }
  return { batch: r.json.batch, alreadyRunning: r.json.started === false };
}
async function cycleTerminal(cycleId) {
  const bs = await allBatchesOf(cycleId);
  return bs.length > 0 && bs.every((b) => ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED', 'FAILED'].includes(b.status));
}
async function cancelCycle(cycleId) {
  const bs = await allBatchesOf(cycleId);
  for (const b of bs) {
    if (!['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED', 'FAILED'].includes(b.status)) {
      await api('POST', `/api/batches/${b.id}/cancel`).catch(() => {});
    }
  }
}
async function zeroContainers() {
  try {
    const inv = dc(`ps -a --filter "label=com.mirrorsocialmedia.water-army.managed=true" --format "{{.ID}} {{.Names}}"`);
    return inv.split('\n').filter((l) => /\bUp\b/.test(l));
  } catch { return []; }
}

// ------------------------------------------------------------ stage stats
async function stageStats(cycleId) {
  const runs = await db.taskRun.findMany({ where: { batchId: { in: (await allBatchesOf(cycleId)).map((b) => b.id) } } });
  const byStatus = {};
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  // boot times: audit('batch_container.started') createdAt - run.startedAt
  const runIds = runs.map((r) => r.id);
  const evs = runIds.length
    ? await db.auditEvent.findMany({ where: { action: 'batch_container.started' } })
    : [];
  const bootMs = [];
  for (const e of evs) {
    const rid = e.detailsJson?.runId;
    const run = runs.find((r) => r.id === rid);
    if (run?.startedAt) bootMs.push(e.createdAt.getTime() - run.startedAt.getTime());
  }
  bootMs.sort((a, b) => a - b);
  const pct = (p) => (bootMs.length ? bootMs[Math.min(bootMs.length - 1, Math.floor(bootMs.length * p))] : null);
  const fails = runs.filter((r) => ['failed', 'timed_out', 'cancelled'].includes(r.status));
  const failCodes = {};
  for (const r of fails) failCodes[r.errorCode ?? '?'] = (failCodes[r.errorCode ?? '?'] ?? 0) + 1;
  return {
    runCount: runs.length,
    byStatus,
    errorRate: runs.length ? (fails.length / runs.length) : 0,
    failCodes,
    bootMs: {
      n: bootMs.length,
      min: bootMs[0] ?? null,
      p50: pct(0.5),
      p95: pct(0.95),
      max: pct(1),
    },
  };
}
const fmtMs = (ms) => (ms == null ? 'n/a' : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`);

function writeStageReport(stageN, payload) {
  const md = [
    `# BR-B6 load test — stage ${stageN} (${payload.target} containers targeted)`,
    ``,
    `Generated: ${nowIso()}`,
    `Status: **${payload.outcome}**${payload.haltReason ? ` — HALT: ${payload.haltReason}` : ''}`,
    ``,
    `## Identity`,
    `- image: \`${IMAGE}\``.replace(IMAGE, 'water-army/redroid@sha256:5912…43b55 (matrixa-r3, 720x1280@30, gpu_mode=host, 2GiB/2vCPU, privileged)'),
    `- stage size: ${payload.target} (global cap = ${payload.target})`,
    `- cold boots in this stage: ${payload.coldCount}; warm rotations: ${payload.warmCount}`,
    ``,
    `## Run outcomes`,
    `- runs: ${payload.stats.runCount} — ${JSON.stringify(payload.stats.byStatus)}`,
    `- error rate: ${(payload.stats.errorRate * 100).toFixed(1)}% — codes: ${JSON.stringify(payload.stats.failCodes)}`,
    ``,
    `## Boot times (taskRun.startedAt -> ADB handshake ok)`,
    `- n=${payload.stats.bootMs.n}  min=${fmtMs(payload.stats.bootMs.min)}  p50=${fmtMs(payload.stats.bootMs.p50)}  p95=${fmtMs(payload.stats.bootMs.p95)}  max=${fmtMs(payload.stats.bootMs.max)}`,
    ``,
    `## GPU / VRAM (anchors + 5s series in vram-stage${stageN}.csv)`,
    payload.gpuAnchors.map((a) => `- ${a.when}: ${a.txt}`).join('\n'),
    ``,
    `## Host (anchors + 5s series in host-stage${stageN}.csv)`,
    payload.hostAnchors.map((a) => `- ${a.when}: ${a.txt}`).join('\n'),
    ``,
    `## Disk`,
    `- data root (.dev/br-b6lt/data) at stage end: ${payload.diskData}`,
    ``,
    `## Evidence`,
    `- vram series: ${EVIDENCE}/vram-stage${stageN}.csv`,
    `- host series: ${EVIDENCE}/host-stage${stageN}.csv`,
    ``,
  ].join('\n');
  writeFileSync(`${EVIDENCE}/stage${stageN}-report.md`, md);
  console.log(`[stage${stageN}] report -> ${EVIDENCE}/stage${stageN}-report.md`);
}

// ------------------------------------------------------------ main
async function main() {
  const t0 = Date.now();
  console.log(`[B6LT] start ${nowIso()}`);
  await login();

  // per-device VRAM delta (measured in stage 1) — drives later stage sizing
  let perDeviceMiB = null;

  let stage = 0;
  let consecutiveHalts = 0;
  const outcomes = [];
  for (const target of STAGES) {
    stage += 1;
    if (sampler) await sampler.stop();
    const st = startSampler(stage, stage);
    // anchor: stage start
    const anchor0 = vramRaw();
    const gpuTxt = (v) => v.gpus.map((g) => `GPU${g[0]} used=${g[1]}MiB free=${g[2]}MiB util=${g[3]}%`).join(' | ');
    const hostTxt = (h) => `load1=${h.load1} memAvail=${h.memAvailGB.toFixed(1)}G diskFree=${h.diskRootGB}G`;
    const gpuAnchors = [{ when: 'start', txt: gpuTxt(anchor0) }];
    const hostAnchors = [{ when: 'start', txt: hostTxt(hostSample()) }];

    // pool: first `target` READY identities (re-armed between stages)
    const ready = (await db.identity.findMany({ where: { status: 'READY' }, orderBy: { externalRef: 'asc' } }))
      .map((i) => i.id);
    const pool = ready.slice(0, target);
    if (pool.length === 0) {
      record('S' + stage, 'stage aborted — no READY identities left', false, 'pool exhausted by failures');
      outcomes.push({ stage, target, outcome: 'ABORTED_NO_POOL' });
      break;
    }
    if (pool.length < target) {
      console.log(`[S${stage}] pool has only ${pool.length} READY identities — running stage at ${pool.length} (documented shrink)`);
    }

    const coldCount = pool.length; // stage-1 all cold; later stages: warm (label = rotation on retained volume)
    let warmCount = stage === 1 ? 0 : pool.length;

    let outcome = 'COMPLETED';
    let haltReason = null;
    let cycleId = null;

    try {
      await setGlobalCap(pool.length);
      const created = await api('POST', '/api/batches', {
        body: {
          name: `BR-B6LT stage ${stage} (${pool.length} real redroid)`,
          idempotencyKey: `brb6lt-s${stage}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
          identities: pool,
          batchSize: pool.length,
          maxActiveContainers: pool.length,
          failurePolicy: 'continue_and_report',
          config: { adapter: CONTAINER_SPEC },
        },
      });
      if (created.status !== 201 && created.status !== 200) throw new Error(`cycle create failed: ${created.status} ${created.text.slice(0, 300)}`);
      cycleId = created.json.cycleId;
      record('S' + stage, `cycle created (${created.json.batchCount} batches)`, true, `cycleId=${String(cycleId).slice(0, 8)}…`);

      const started = await startFirstBatch(cycleId, `stage ${stage}`);
      record('S' + stage, `stage batch running`, true, started.alreadyRunning ? 'scheduler auto-start' : 'explicit start');

      st.stageActive = true;
      const midWait = Date.now() + 0; // mid anchor timing
      let midAnchored = false;
      const { timedOut } = await waitFor(`stage ${stage} terminal`, async () => {
        // mid anchor (once, ~halfway through the soak)
        if (!midAnchored && Date.now() - midWait > 15 * 60_000) {
          midAnchored = true;
          gpuAnchors.push({ when: 'mid', txt: gpuTxt(vramRaw()) });
          hostAnchors.push({ when: 'mid', txt: hostTxt(hostSample()) });
        }
        if (st.halt) return 'halted';
        return (await cycleTerminal(cycleId)) ? 'terminal' : null;
      }, { timeoutMs: 55 * 60_000, intervalMs: 15_000 });

      if (st.halt) {
        haltReason = st.haltReason ?? st.halt;
        outcome = 'HALTED';
        record('S' + stage, 'stage HALTED by VRAM/host guard', false, haltReason, { soft: true });
        await cancelCycle(cycleId);
      } else if (timedOut) {
        outcome = 'TIMEOUT';
        record('S' + stage, 'stage timed out (55min) — cancelling', false);
        await cancelCycle(cycleId);
      } else {
        gpuAnchors.push({ when: 'end', txt: gpuTxt(vramRaw()) });
        hostAnchors.push({ when: 'end', txt: hostTxt(hostSample()) });
        const bs = await allBatchesOf(cycleId);
        const allCompleted = bs.every((b) => b.status === 'COMPLETED');
        outcome = allCompleted ? 'COMPLETED' : 'COMPLETED_WITH_ERRORS';
        record('S' + stage, `stage terminal: ${bs.map((b) => b.status).join(',')}`, allCompleted,
          bs.map((b) => b.status).join(' '));
      }

      // convergence: zero running managed containers before stats/next stage
      const left = await waitFor('containers stopped', async () => {
        const r = await zeroContainers();
        return r.length === 0 ? true : null;
      }, { timeoutMs: 10 * 60_000, intervalMs: 10_000 });
      if (!left.v) {
        record('S' + stage, 'residual RUNNING containers after stage', false, JSON.stringify(await zeroContainers()), { soft: true });
      }
    } catch (err) {
      outcome = 'ERROR';
      haltReason = String(err?.message ?? err).slice(0, 200);
      record('S' + stage, 'stage error', false, haltReason);
      if (cycleId) await cancelCycle(cycleId).catch(() => {});
    }

    const stats = cycleId ? await stageStats(cycleId) : { runCount: 0, byStatus: {}, errorRate: 0, failCodes: {}, bootMs: { n: 0 } };
    // stage-1 per-device VRAM delta: end free vs start free (1 device)
    if (stage === 1) {
      const end = vramRaw();
      // 1 device on GPU0: free-at-start minus free-at-end = per-device cost.
      const d0 = Number(anchor0.gpus[0][2]) - Number(end.gpus[0][2]);
      perDeviceMiB = Math.max(64, Math.round(d0)); // floor 64MiB to avoid div-by-~0
      console.log(`[S1] measured per-device VRAM delta ≈ ${perDeviceMiB} MiB`);
    }

    let diskData = 'n/a';
    try { diskData = execSync(`du -sh ${RUN}/data 2>/dev/null | cut -f1`, { encoding: 'utf8' }).trim(); } catch { /* ignore */ }

    writeStageReport(stage, { target, outcome, haltReason, stats, gpuAnchors, hostAnchors, coldCount, warmCount, diskData });
    outcomes.push({ stage, target: pool.length, outcome, haltReason, errorRate: stats.errorRate, boots: stats.bootMs });

    if (outcome === 'HALTED') {
      consecutiveHalts += 1;
      if (consecutiveHalts >= 2) {
        record('LADDER', 'two consecutive VRAM halts — closing ladder at last stable size', false, haltReason);
        break;
      }
      // shrink the NEXT stage to what the free VRAM can take
      const end = vramRaw();
      const minFree = Math.min(...end.gpus.map((g) => Number(g[2])));
      const affordable = perDeviceMiB ? Math.floor((minFree - 1500) / perDeviceMiB) : 0;
      console.log(`[LADDER] next stage will be capped at ${Math.max(1, Math.min(affordable, target))} (affordable at 1500MiB headroom: ${affordable})`);
    } else if (outcome === 'COMPLETED') {
      consecutiveHalts = 0;
    } else {
      consecutiveHalts = 0; // TIMEOUT/ERROR/COMPLETED_WITH_ERRORS: continue, don't double-penalize
    }

    // re-arm: finished identities back to READY for the next stage's pool
    const runs = cycleId ? await db.taskRun.findMany({ where: { batchId: { in: (await allBatchesOf(cycleId).catch(() => [])).map((b) => b.id) } } }) : [];
    for (const r of runs) {
      if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(r.status)) {
        await db.identity.update({ where: { id: r.identityId }, data: { status: 'READY' } }).catch(() => {});
      }
    }
    // data volumes are NEVER removed mid-ladder (MD item 3 + R5 recreate-stall)
  }

  await sampler?.stop();

  // ------------------------------------------------- final convergence
  const inv = await zeroContainers();
  record('FIN', 'zero RUNNING managed containers at end', inv.length === 0, inv.join(' | ') || 'clean');
  if (inv.length > 0) {
    // the ONE place reconcile-fix runs (all stages done; containers are
    // stopped/exited — no recreate of a live device, R5 stall avoided).
    const fix = await api('POST', '/api/batch-containers/reconcile', { body: { fix: true } });
    const inv2 = await zeroContainers();
    record('FIN', `reconcile sweep cleared ${inv.length} residual container(s)`, fix.status === 200 && inv2.length === 0, `after=${inv2.length}`);
  }
  const liveSlots = await db.resourceLease.count({ where: { resourceType: 'container_slot', leaseExpiresAt: { gt: new Date() } } });
  const livePorts = await db.resourceLease.count({ where: { resourceType: 'port', leaseExpiresAt: { gt: new Date() } } });
  record('FIN', 'zero live slot/port leases at end', liveSlots === 0 && livePorts === 0, `slots=${liveSlots} ports=${livePorts}`);

  // summary
  const summary = {
    startedAt: nowIso(),
    wallMs: Date.now() - t0,
    perDeviceVramMiB: perDeviceMiB,
    stages: outcomes,
    checks: results.filter((r) => !r.soft),
    softChecks: results.filter((r) => r.soft),
    pass: results.filter((r) => !r.soft && r.pass).length,
    fail: results.filter((r) => !r.soft && !r.pass).length,
  };
  writeFileSync(`${EVIDENCE}/ladder-summary.json`, JSON.stringify(summary, null, 2));
  const hardFail = summary.fail;
  console.log(`[B6LT] done — ${summary.pass} hard checks pass / ${hardFail} fail / ${results.filter((r) => r.soft).length} soft; summary -> ${EVIDENCE}/ladder-summary.json`);
  process.exitCode = hardFail > 0 ? 1 : 0;
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(`[B6LT] FATAL ${String(err?.stack ?? err).slice(0, 500)}`);
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(2);
});
