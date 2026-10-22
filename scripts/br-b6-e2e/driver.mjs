/**
 * BR-B6 E2E driver — MD §14.3 sandbox cycle (200 identities / 4 batches).
 *
 * Runs on the host against the 163xx scratch stack (setup.sh) with REAL
 * docker containers (water-army/brb6-adb-mock:20261022) — the container
 * adapter's full live path (create → ADB-handshake health → hold → stop,
 * volume mounts, port leases, adoption, reconciliation).
 *
 * Phase → MD §14.3 item map:
 *   P0  preview + create (200 ids, 4×50) + duplicate-request idempotency  → item 1 (+防重複派發)
 *   P1  start + overlap cycle + global-cap lease sampler                  → item 2 (cap 6 binds across cycles)
 *   P2  transient failure (docker kill mid-hold) → policy retry + logs    → item 4
 *   P3a API restart mid-cycle (worker keeps/retries via adoption)         → item 6
 *   P3b worker SIGKILL mid-hold → lease expiry → RECOVERING isolation
 *       (MD §6.2 red line: NO auto re-run) → worker restart → job
 *       redelivery → honest cancel → reconcile-fix cleans the orphan     → item 6
 *   P4  permanent failure (broken image) → retries exhausted →
 *       COMPLETED_WITH_ERRORS per failure_policy                          → item 5
 *   P5  final: every identity exactly ONE terminal result, no double
 *       success, attempt_started uniqueness, volumes retained, zero
 *       residual running containers / live leases                         → items 3 + 8
 *
 * Exit 0 = all hard checks passed; 1 = hard failure; 2 = driver crash.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, openSync } from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const API = 'http://127.0.0.1:16343';
const RUN = '.dev/br-b6-e2e';
const EVIDENCE = process.env.BRB6_E2E_EVIDENCE_DIR ?? '/home/kenneth/.openclaw/workspace/logs/br-b6-e2e';
const GOOD_IMAGE = 'water-army/brb6-adb-mock:20261022';
const BROKEN_IMAGE = 'water-army/brb6-broken:20261022';
mkdirSync(EVIDENCE, { recursive: true });

const dbUrl = readFileSync(`${RUN}/api.env`, 'utf8').split('\n')
  .find((l) => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
if (!dbUrl) throw new Error('DATABASE_URL missing from api.env — run setup.sh first');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });
await db.$connect();

const seed = JSON.parse(readFileSync(`${RUN}/identities.json`, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dc = (args) => execSync(`sg docker -c "docker ${args}"`, { encoding: 'utf8' });

let cookie;
const results = [];
function record(phase, name, pass, detail = '', { soft = false } = {}) {
  results.push({ phase, name, pass: !!pass, detail: String(detail).slice(0, 300), soft });
  console.log(`[${phase}] ${pass ? 'PASS' : 'FAIL'}${soft ? ' (soft)' : ''} — ${name}${detail ? ` (${detail})` : ''}`);
  return !!pass;
}

async function api(method, path, { body, tokenOnly = false } = {}) {
  const headers = tokenOnly ? {} : { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function login() {
  const res = await api('POST', '/api/auth/login', {
    body: { username: seed.admin.username, password: seed.admin.password }, tokenOnly: true,
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  cookie = res.headers.get('set-cookie').split(';')[0];
}
async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 300 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return { v, timedOut: false, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v: null, timedOut: true, elapsedMs: Date.now() - t0 };
    await sleep(intervalMs);
  }
}
const TERMINAL_BATCH = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED', 'FAILED'];
const TERMINAL_RUN = ['succeeded', 'failed', 'timed_out', 'cancelled'];
const CONTAINER_SPEC = {
  type: 'container',
  image: GOOD_IMAGE,
  health: { kind: 'adb-tcp', port: 5555 },
  work: { kind: 'hold', durationMs: 2000 },
};

// ---------------------------------------------------------------- processes
// apiProc is a handle {pid, kill(sig), exitCode} — either a driver-spawned
// child (P3a restart) or the run.sh-owned process (re-adopted from pids/api
// at driver start; the driver's P3a SIGTERM/restart works on both).
let apiProc = null;
const workers = new Map(); // name -> {pid, proc}

function handleFromPid(pid) {
  return {
    pid,
    kill: (sig) => { try { process.kill(pid, sig); } catch { /* already gone */ } },
    get exitCode() {
      try { process.kill(pid, 0); return null; } catch (e) { return e.code === 'ESRCH' ? -1 : null; }
    },
  };
}

function envFromFile(p) {
  const env = { ...process.env };
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}
function startApi() {
  const env = envFromFile(`${RUN}/api.env`);
  const proc = spawn('node', ['apps/api/src/server.js'], {
    env,
    stdio: ['ignore', openSync(`${RUN}/api.log`, 'a'), openSync(`${RUN}/api.err.log`, 'a')],
  });
  mkdirSync(`${RUN}/pids`, { recursive: true });
  writeFileSync(`${RUN}/pids/api`, String(proc.pid));
  apiProc = {
    pid: proc.pid,
    kill: (sig) => proc.kill(sig),
    get exitCode() { return proc.exitCode; },
  };
  return proc.pid;
}
function startWorker(name, { healthPort, scheduler = true } = {}) {
  const env = envFromFile(`${RUN}/worker-base.env`);
  env.WORKER_HEALTH_PORT = String(healthPort);
  env.BATCH_SCHEDULER_ENABLED = String(scheduler);
  const log = spawn('node', ['apps/worker/src/worker.js'], {
    env,
    stdio: ['ignore', openSync(`${RUN}/worker${name}.log`, 'a'), openSync(`${RUN}/worker${name}.err.log`, 'a')],
  });
  writeFileSync(`${RUN}/pids/w${name}`, String(log.pid));
  workers.set(name, { pid: log.pid, proc: log });
  return log.pid;
}
async function stopApi() {
  if (!apiProc || apiProc.exitCode !== null) return;
  apiProc.kill('SIGTERM');
  const t0 = Date.now();
  while (apiProc.exitCode === null && Date.now() - t0 < 15_000) await sleep(100);
  if (apiProc.exitCode === null) apiProc.kill('SIGKILL');
}
function kill9Worker(name) {
  const w = workers.get(name);
  if (!w || w.proc.exitCode !== null) return false;
  w.proc.kill('SIGKILL');
  return true;
}
function workerLog(name) {
  const p = `${RUN}/worker${name}.log`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
function apiLog() {
  const p = `${RUN}/api.log`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
async function waitApiReady(timeoutMs = 45_000) {
  return waitFor('api ready', async () => {
    const r = await fetch(`${API}/api/health/ready`);
    return r.status === 200;
  }, { timeoutMs, intervalMs: 400 }).then((r) => !r.timedOut);
}
async function workerDrain(name, timeoutMs = 10_000) {
  const w = workers.get(name);
  if (!w) return true;
  const t0 = Date.now();
  while (w.proc.exitCode === null && Date.now() - t0 < timeoutMs) await sleep(100);
  return w.proc.exitCode !== null;
}

// ------------------------------------------------------- lease sampler (150ms)
const leaseSamples = [];
let samplerTimer = null;
function startSampler(intervalMs = 150) {
  samplerTimer = setInterval(() => {
    db.resourceLease.count({ where: { resourceType: 'container_slot', leaseExpiresAt: { gt: new Date() } } })
      .then((n) => leaseSamples.push({ t: Date.now(), n }))
      .catch(() => {});
  }, intervalMs);
  if (typeof samplerTimer.unref === 'function') samplerTimer.unref();
}
function stopSampler() {
  if (samplerTimer) clearInterval(samplerTimer);
  samplerTimer = null;
  return leaseSamples.reduce((m, s) => Math.max(m, s.n), 0);
}
const samplerSeries = () => leaseSamples;

// ------------------------------------------------------------------- helpers
async function batchDetail(id) {
  const r = await api('GET', `/api/batches/${id}?runsLimit=500`);
  if (r.status !== 200) throw new Error(`batch detail ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json;
}
async function allBatchesOf(cycleId) {
  return db.batch.findMany({ where: { cycleId }, orderBy: { batchNo: 'asc' } });
}
async function cycleTerminal(cycleId) {
  const bs = await allBatchesOf(cycleId);
  if (!bs.length) return false;
  for (const b of bs) {
    if (!TERMINAL_BATCH.includes(b.status)) return false;
    const runs = await db.taskRun.findMany({ where: { batchId: b.id } });
    if (!runs.length || !runs.every((r) => TERMINAL_RUN.includes(r.status))) return false;
  }
  return true;
}
// Batch containers carry com.mirrorsocialmedia.water-army.* labels (the
// user's compose containers share app.managed=true — never filter on that
// alone: it would count water-army-{web,api,worker}-1, which are zero-touch).
const BATCH_LABEL = 'com.mirrorsocialmedia.water-army.task-run-id';
async function runningManagedCount() {
  try {
    const out = dc(`ps --filter "label=${BATCH_LABEL}" --filter "status=running" --format "{{.ID}}"`).trim();
    return out ? out.split('\n').length : 0;
  } catch { return 0; }
}
async function managedInventory() {
  try {
    return dc(`ps -a --filter "label=${BATCH_LABEL}" --format "{{.ID}} {{.Status}} {{.Names}}"`).trim().split('\n').filter(Boolean);
  } catch { return []; }
}

// --------------------------------------------------------------------- P0
async function phase0() {
  const mainIds = seed.main.map((i) => i.id);
  // 1) preview: 4 batches × 50 members (196 PENDING + 4 SKIPPED-with-reason)
  const prev = await api('POST', '/api/batches/preview', { body: { identities: mainIds, batchSize: 50, maxActiveContainers: 5, failurePolicy: 'continue_and_report' } });
  const plan = prev.json?.plan;
  const okPrev = prev.status === 200 && (prev.json?.unknown?.length ?? 0) === 0
    && plan?.batches?.length === 4
    && plan.batches.every((b) => b.members?.length === 50)
    && prev.json?.estimate?.identitiesSkipped === 4
    && plan.batches.every((b) => b.members.filter((m) => m.state === 'SKIPPED').length === 1);
  record('P0', 'preview shows 4 batches × 50 (200 identities, 4 skipped with reasons)', okPrev,
    okPrev ? '' : `status=${prev.status} ${prev.text.slice(0, 200)}`);

  // 2) create the cycle (container adapter spec)
  const key = 'brb6-e2e-cycle-20261022';
  const create = await api('POST', '/api/batches', {
    body: {
      name: 'BR-B6 E2E main cycle (200 ids)',
      idempotencyKey: key,
      identities: mainIds,
      batchSize: 50,
      maxActiveContainers: 5,
      failurePolicy: 'continue_and_report',
      config: { adapter: CONTAINER_SPEC },
    },
  });
  if (create.status !== 201) throw new Error(`P0 create failed: ${create.status} ${create.text.slice(0, 300)}`);
  const cycleId = create.json.cycleId;
  record('P0', 'create 200-id cycle → 4 batches', create.json.batches?.length === 4,
    `cycleId=${String(cycleId).slice(0, 8)}…`);

  // 3) duplicate create (same idempotency key) → SAME cycle, no second one
  const dup = await api('POST', '/api/batches', {
    body: {
      name: 'BR-B6 E2E main cycle (200 ids)', idempotencyKey: key, identities: mainIds,
      batchSize: 50, maxActiveContainers: 5, failurePolicy: 'continue_and_report',
      config: { adapter: CONTAINER_SPEC },
    },
  });
  const cycles = await db.batch.count({ where: { cycleId } });
  record('P0', 'duplicate create (same key) → same cycle, no double cycle',
    dup.status === 200 && dup.json?.cycleId === cycleId,
    `dup status=${dup.status}, cycleId match=${dup.json?.cycleId === cycleId}, batch rows=${cycles}`);

  // 4) skip reporting for the 4 DISABLED identities (explicit reasons)
  const skips = await db.batchIdentity.findMany({ where: { batch: { cycleId }, status: 'SKIPPED' } });
  record('P0', '4 DISABLED identities → SKIPPED membership WITH reasons',
    skips.length === 4 && skips.every((s) => s.skipReason && s.skipReason.length > 3),
    `skips=${skips.length} reasons=${skips.map((s) => (s.skipReason ?? '').slice(0, 40)).join(' | ')}`);

  // 5) set the GLOBAL cap (6 < batch caps in play) — the cap the sampler proves
  const cap = await api('POST', '/api/batches/capacity', { body: { maxActiveContainers: 6 } });
  record('P0', 'global cap set to 6 (AppSetting)', cap.status === 200, `status=${cap.status}`);

  return cycleId;
}

// --------------------------------------------------------------------- P1
async function ensureBatchStarted(batchId, label) {
  // Race-tolerant start: the worker scheduler AUTO-STARTS PLANNED batches
  // within a tick (progressCycles — B2-verified behavior). An explicit POST
  // start is the fallback for scheduler-off environments. Both paths must
  // converge on RUNNING. startBatch is CAS PLANNED→RUNNING, so a lost race
  // returns 200 {started:false, reason:'already-running'} (contract: batches
  // -api.test.js "already-running no-op"), NEVER a second dispatch.
  const CONVERGED = ['RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'];
  for (let i = 0; i < 60; i += 1) {
    const b = await db.batch.findUnique({ where: { id: batchId } });
    if (b && CONVERGED.includes(b.status)) return { auto: true, status: b.status };
    const r = await api('POST', `/api/batches/${batchId}/start`);
    if (r.status === 202) return { auto: false, status: 'RUNNING' };
    if (r.status === 200) {
      // scheduler won the race (or the batch converged between read and POST)
      const b2 = await db.batch.findUnique({ where: { id: batchId } });
      if (b2 && CONVERGED.includes(b2.status)) return { auto: true, status: b2.status };
      await sleep(500); continue;
    }
    if (r.status === 409) { await sleep(500); continue; } // scheduler mid-race — recheck
    throw new Error(`${label} start failed: ${r.status} ${r.text.slice(0, 200)}`);
  }
  throw new Error(`${label}: batch never left PLANNED`);
}

async function startMainCycle(cycleId) {
  const b1 = (await allBatchesOf(cycleId))[0];
  const res = await ensureBatchStarted(b1.id, 'main cycle batch 1');
  record('P1', 'main cycle batch 1 running (explicit start or scheduler auto-start)', ['RUNNING', 'PAUSED'].includes(res.status),
    `via=${res.auto ? 'scheduler auto-start' : 'explicit start'} status=${res.status}`);
  // duplicate start on a RUNNING batch → 200 {started:false} idempotent no-op
  // (contract: batches-api.test.js "already-running no-op"), never a 2nd dispatch
  await sleep(500);
  const start2 = await api('POST', `/api/batches/${b1.id}/start`);
  const stillOne = await db.taskRun.count({ where: { batchId: b1.id } }) <= 50;
  const dupOk = (start2.status === 200 && start2.json?.started === false) || start2.status === 409;
  record('P1', 'duplicate start → idempotent no-op (no double dispatch)', dupOk && stillOne,
    `status=${start2.status} started=${start2.json?.started} reason=${start2.json?.reason ?? ''}`.slice(0, 120));
}

async function phase1(cycleId) {
  startSampler();
  const mainDetail0 = await batchDetail((await allBatchesOf(cycleId))[0].id);
  // overlap cycle: 10 identities, maxActive 10 → effective min(10, global 6) = 6.
  // While the main cycle's batch-1 (cap 5) runs, this one competes for the
  // SAME global slot pool (slot-0..slot-5) → total can never exceed 6.
  const overlapIds = seed.overlap.map((i) => i.id);
  const oc = await api('POST', '/api/batches', {
    body: {
      name: 'BR-B6 E2E overlap cycle (cap probe)',
      idempotencyKey: 'brb6-e2e-overlap-20261022',
      identities: overlapIds,
      batchSize: 10,
      maxActiveContainers: 10,
      failurePolicy: 'continue_and_report',
      config: { adapter: CONTAINER_SPEC },
    },
  });
  if (oc.status !== 201) throw new Error(`P1 overlap create failed: ${oc.status} ${oc.text.slice(0, 300)}`);
  const overlapCycleId = oc.json.cycleId;

  // wait until the main cycle actually has live containers, THEN start the
  // overlap (guarantees a real overlap window, not sequential execution).
  await waitFor('main cycle live containers', async () => (await runningManagedCount()) >= 2, { timeoutMs: 120_000 });
  const osRes = await ensureBatchStarted((await allBatchesOf(overlapCycleId))[0].id, 'overlap cycle batch 1');
  record('P1', 'overlap cycle running while main cycle running', ['RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(osRes.status),
    `via=${osRes.auto ? 'auto-start' : 'explicit'} status=${osRes.status}`);
  console.log(`[P1] overlap window open (main=${String(cycleId).slice(0, 8)}… overlap=${String(overlapCycleId).slice(0, 8)}…)`);

  const { timedOut } = await waitFor('both cycles terminal', async () =>
    (await cycleTerminal(cycleId)) && (await cycleTerminal(overlapCycleId)), { timeoutMs: 2_400_000, intervalMs: 1_000 });
  const samplerMax = stopSampler();
  const capHeld = samplerMax <= 6;
  record('P1', 'global active containers NEVER exceeded the cap of 6 (150ms lease sampler)', capHeld,
    `sampler max=${samplerMax} over ${leaseSamples.length} samples`);
  record('P1', 'cap was actually BINDING (sampler saw 6 live slots during overlap)', samplerMax >= 6,
    `max=${samplerMax} — soft: timing-dependent`, { soft: true });
  const overlapRuns = await db.taskRun.findMany({ where: { batchId: { in: (await allBatchesOf(overlapCycleId)).map((b) => b.id) } } });
  record('P1', 'overlap cycle 10/10 succeeded', overlapRuns.length === 10 && overlapRuns.every((r) => r.status === 'succeeded'),
    `${overlapRuns.filter((r) => r.status === 'succeeded').length}/10`);
  return { overlapCycleId, samplerMax };
}

// --------------------------------------------------------------------- P2
async function injectTransientFailure(target, stopIf) {
  for (;;) {
    if (await stopIf().catch(() => true)) return { killed: false, aborted: true };
    const run = await db.taskRun.findFirst({
      where: { identityId: target.id, status: 'running', containerId: { not: null } },
      orderBy: { startedAt: 'desc' },
    });
    if (run) {
      try {
        dc(`kill ${run.containerId}`);
        return { killed: true, runId: run.id, attemptAtKill: run.attempt, containerId: run.containerId, target: target.ref };
      } catch {
        /* container exited between DB read and kill — loop retries */
      }
    }
    // window passed: the target's run went terminal without a live container
    // ever being visible to us (it finished between polls, or failed early)
    const terminalRun = await db.taskRun.findFirst({
      where: { identityId: target.id, status: { in: TERMINAL_RUN } },
    });
    if (terminalRun) return { killed: false, windowPassed: true };
    await sleep(250);
  }
}
async function assertTransientRecovery(phase, inj) {
  if (!inj?.killed) {
    record(phase, 'transient failure injected (docker kill mid-hold)', false, `window missed on all targets (lateAll=${inj?.lateAll ?? 'n/a'})`);
    return false;
  }
  const run = await waitFor('transient run terminal', async () => {
    const r = await db.taskRun.findUnique({ where: { id: inj.runId } });
    return TERMINAL_RUN.includes(r?.status) ? r : null;
  }, { timeoutMs: 180_000 });
  const r = run.v;
  const ok = r?.status === 'succeeded' && r.attempt >= Math.max(2, inj.attemptAtKill);
  record(phase, `transient failure (killed attempt ${inj.attemptAtKill}) → retried + SUCCEEDED (final attempt ${r?.attempt})`, ok,
    `status=${r?.status} attempt=${r?.attempt} code=${r?.errorCode ?? ''}`);
  const evs = await db.taskRunEvent.findMany({ where: { taskRunId: inj.runId, eventType: 'attempt_started' } });
  record(phase, 'retry produced a second attempt_started (policy retry, logged)', evs.length >= 2,
    `${evs.length} attempt_started events`);
  return ok;
}

// --------------------------------------------------------------------- P3
async function phase3aApiRestart() {
  console.log('[P3a] SIGTERM API mid-cycle…');
  const pid = apiProc.pid;
  await stopApi();
  record('P3a', 'API process stopped (SIGTERM)', apiProc.exitCode !== null, `pid=${pid} exitCode=${apiProc.exitCode}`);
  startApi();
  const ready = await waitApiReady();
  record('P3a', 'API restarted + ready', ready, `new pid=${apiProc.pid}`);
}

async function phase3bWorkerKill() {
  // kill while ≥2 containers are live (mid-hold is the interesting window)
  await waitFor('live containers for worker kill', async () => (await runningManagedCount()) >= 2, { timeoutMs: 600_000 });
  // SNAPSHOT the in-flight runs: every one of them loses its executor at the
  // kill (single worker) → each becomes a victim to be reconciled.
  const snapshot = await db.taskRun.findMany({ where: { status: 'running', containerId: { not: null } } });
  console.log(`[P3b] SIGKILL worker at ${new Date().toISOString()} (live containers: ${await runningManagedCount()}, in-flight runs: ${snapshot.length})`);
  const killed = kill9Worker('1');
  await workerDrain('1');
  record('P3b', 'worker SIGKILLed mid-cycle', killed, `pid=${workers.get('1')?.pid} victims=${snapshot.length}`);

  // wait for the lease to expire (8s TTL) — but NO reconciliation happens
  // while the worker is dead (the reconciler runs IN the worker). Restart at
  // +15s so the fresh scheduler sees the expired leases on its first tick.
  await sleep(15_000);
  startWorker('2', { healthPort: 16345 });
  record('P3b', 'worker restarted (new pid, scheduler on)', workers.get('2')?.pid != null, `pid=${workers.get('2')?.pid}`);

  // Each victim: lease expires → scheduler isolates (identity RECOVERING —
  // quarantine) + honestly CANCELS the run + mirrors membership CANCELLED
  // (MD §6.2 red line: NO auto re-run; the identity is released only by an
  // explicit human review, never by auto sync). BullMQ stalled-job
  // redelivery can race the isolation — the engine stop path and the sync
  // plan are both red-line-safe (neither clobbers RECOVERING), so EVERY
  // ordering converges to: run cancelled + identity RECOVERING.
  const t0 = Date.now();
  const victimIds = new Set(snapshot.map((r) => r.id));
  let sawRecovering = false;
  let allResolved = false;
  while (Date.now() - t0 < 240_000) {
    const rec = await db.identity.findFirst({ where: { status: 'RECOVERING' } });
    if (rec) sawRecovering = true;
    const victims = await db.taskRun.findMany({ where: { id: { in: [...victimIds] } } });
    allResolved = victims.length === victimIds.size && victims.every((r) => TERMINAL_RUN.includes(r.status));
    if (allResolved) break;
    await sleep(500);
  }
  const victims = await db.taskRun.findMany({ where: { id: { in: [...victimIds] } } });
  const victimIdentities = victims.length
    ? await db.identity.findMany({ where: { id: { in: victims.map((r) => r.identityId) } } })
    : [];
  record('P3b', 'orphaned runs reconciled: identity RECOVERING isolation observed (MD §6.2 red line)', sawRecovering,
    sawRecovering ? 'CRITICAL isolation path taken' : 'job-redelivery race won before isolation (legal ordering b)', { soft: true });
  record('P3b', `all ${victimIds.size} orphaned runs ended CANCELLED + identities RECOVERING (isolated, no auto re-run — MD §6.2 red line)`,
    allResolved && victims.every((r) => r.status === 'cancelled') && victimIdentities.length === victims.length && victimIdentities.every((i) => i.status === 'RECOVERING'),
    victims.map((r) => `${r.status}`).join(',') + ` identities=${victimIdentities.map((i) => i.status).join(',')}`);

  // NO double execution of any victim attempt (claim CAS invariant)
  const evs = await db.taskRunEvent.findMany({ where: { taskRunId: { in: [...victimIds] }, eventType: 'attempt_started' } });
  const byKey = new Map();
  for (const e of evs) {
    const k = `${e.taskRunId}:a${e.payloadJson?.attempt ?? 'unknown'}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  record('P3b', 'no duplicate attempt_started for any orphaned run', [...byKey.values()].every((c) => c === 1),
    `${evs.length} events / ${byKey.size} keys`);

  // The orphan containers (still running — nobody's executor stopped them) →
  // reconcile fix (the operator's recovery surface) must stop+remove them.
  const invBefore = await managedInventory();
  const runningOrphans = invBefore.filter((l) => /\bUp\b/.test(l));
  const fix = await api('POST', '/api/batch-containers/reconcile', { body: { fix: true } });
  const invAfter = await managedInventory();
  const runningAfter = invAfter.filter((l) => /\bUp\b/.test(l));
  record('P3b', `reconcile(fix=true) cleaned ${runningOrphans.length} orphan container(s) (zero running managed after)`,
    fix.status === 200 && runningAfter.length === 0,
    `fix status=${fix.status}; running ${runningOrphans.length} → ${runningAfter.length}`);
  const fixedAudit = await db.auditEvent.findFirst({ where: { action: 'batch_reconcile.fixed' } });
  record('P3b', 'reconcile fix audited (batch_reconcile.fixed)', Boolean(fixedAudit), fixedAudit ? 'audit row present' : 'no audit row');
}

// --------------------------------------------------------------------- P5
async function phase5(cycleId) {
  const idents = await db.identity.findMany({ where: { externalRef: { in: seed.main.map((m) => m.ref) } } });
  const byRef = new Map(idents.map((i) => [i.externalRef, i]));
  const runs = await db.taskRun.findMany({ where: { identityId: { in: idents.map((i) => i.id) } } });
  const runsByIdentity = new Map();
  for (const r of runs) {
    if (!runsByIdentity.has(r.identityId)) runsByIdentity.set(r.identityId, []);
    runsByIdentity.get(r.identityId).push(r);
  }

  // exactly ONE terminal result per identity: 1 run row (terminal, ≤1
  // succeeded) — OR a SKIPPED membership with zero run rows (MD §3.3: the
  // approved skip IS the terminal result for a disabled identity).
  const mainIds = new Set(idents.map((i) => i.id));
  const skippedIds = new Set(
    (await db.batchIdentity.findMany({ where: { status: 'SKIPPED' }, select: { identityId: true } }))
      .map((m) => m.identityId)
      .filter((id) => mainIds.has(id)),
  );
  const bad = [];
  const statusCounts = {};
  for (const i of idents) {
    const rs = runsByIdentity.get(i.id) ?? [];
    statusCounts[i.status] = (statusCounts[i.status] ?? 0) + 1;
    if (skippedIds.has(i.id)) {
      if (rs.length !== 0) bad.push(`${i.externalRef}: SKIPPED identity has ${rs.length} run rows`);
    } else if (rs.length !== 1) bad.push(`${i.externalRef}: ${rs.length} run rows`);
    else if (!TERMINAL_RUN.includes(rs[0].status)) bad.push(`${i.externalRef}: run not terminal (${rs[0].status})`);
    else if (rs.filter((r) => r.status === 'succeeded').length > 1) bad.push(`${i.externalRef}: double success`);
  }
  record('P5', '200 identities: exactly ONE terminal result each (no miss, no double run, no double success)',
    bad.length === 0, bad.slice(0, 5).join(' | ') || `statusCounts=${JSON.stringify(statusCounts)}`);

  const skipped = await db.batchIdentity.findMany({ where: { status: 'SKIPPED' } });
  const disabledOk = skipped.length >= 4 && skipped.every((s) => s.skipReason?.length > 3);
  record('P5', 'skipped identities carry explicit reasons in the report surface', disabledOk,
    `${skipped.length} SKIPPED memberships, all with skipReason`);

  // attempt_started uniqueness across the WHOLE scratch DB (claim CAS invariant)
  const evs = await db.taskRunEvent.findMany({ where: { eventType: 'attempt_started' } });
  const byKey = new Map();
  for (const e of evs) {
    const k = `${e.taskRunId}:a${e.payloadJson?.attempt ?? 'unknown'}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  const dups = [...byKey.entries()].filter(([, c]) => c > 1);
  record('P5', 'attempt_started uniqueness across ALL runs (no double execution anywhere)', dups.length === 0,
    `${evs.length} events / ${byKey.size} (run,attempt) keys${dups.length ? ` DUPS=${dups.slice(0, 3)}` : ''}`);

  // volumes retained (item 3): heartbeat.log exists for every identity that ran
  const root = `${RUN}/data`;
  const missing = [];
  let present = 0;
  for (const i of idents) {
    const f = `${root}/${i.externalRef}/heartbeat.log`;
    if (existsSync(f)) present += 1;
    else missing.push(i.externalRef);
  }
  const ranCount = 200 - 4; // disabled never ran
  record('P5', 'identity data RETAINED after stop (heartbeat files in mounted volumes)',
    present >= ranCount, `${present}/${ranCount} ran identities have heartbeat.log${missing.length ? ` missing: ${missing.slice(0, 4).join(',')}` : ''}`);

  // zero residual running managed containers; clean up any exited leftovers
  const inv = await managedInventory();
  const runningLeft = inv.filter((l) => /\bUp\b/.test(l));
  record('P5', 'zero RUNNING managed containers at end', runningLeft.length === 0,
    runningLeft.slice(0, 3).join(' | ') || 'clean');
  if (inv.length > 0) {
    const fix = await api('POST', '/api/batch-containers/reconcile', { body: { fix: true } });
    const inv2 = await managedInventory();
    record('P5', `reconcile sweep cleared ${inv.length} residual container(s)`, fix.status === 200 && inv2.length === 0,
      `after=${inv2.length}`);
  }

  // zero live leases of any kind
  const liveSlots = await db.resourceLease.count({ where: { resourceType: 'container_slot', leaseExpiresAt: { gt: new Date() } } });
  const livePorts = await db.resourceLease.count({ where: { resourceType: 'port', leaseExpiresAt: { gt: new Date() } } });
  record('P5', 'zero live slot/port leases at end', liveSlots === 0 && livePorts === 0, `slots=${liveSlots} ports=${livePorts}`);

  // overlap cycle identities: 10 COMPLETED
  const overlapStatuses = await db.identity.findMany({ where: { externalRef: { startsWith: 'brb6-x' } }, select: { status: true } });
  record('P5', 'overlap cycle 10 identities all COMPLETED',
    overlapStatuses.length === 10 && overlapStatuses.every((i) => i.status === 'COMPLETED'),
    JSON.stringify(overlapStatuses.map((i) => i.status)));

  // main cycle batch statuses
  const mainBatches = await allBatchesOf(cycleId);
  const batchStatuses = mainBatches.map((b) => `${b.batchNo}:${b.status}`).join(' ');
  record('P5', 'main cycle 4 batches all terminal (COMPLETED or COMPLETED_WITH_ERRORS)',
    mainBatches.length === 4 && mainBatches.every((b) => ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(b.status)),
    batchStatuses);

  // wave (brb6-f) + P4 (brb6-g) identities: exactly one terminal result each
  for (const [prefix, label, okStatus] of [
    // victim: run cancelled + identity RECOVERING (quarantine, human
    // review); survivor: run succeeded + identity COMPLETED. Anything else
    // (e.g. a COMPLETED identity behind a cancelled run = auto re-run) is a
    // red-line violation and fails the check.
    ['brb6-f', 'restart wave (P3)', (i, r) => (i.status === 'COMPLETED' && r.status === 'succeeded') || (i.status === 'RECOVERING' && r.status === 'cancelled')],
    ['brb6-g', 'permanent-failure cycle (P4)', (i, r) => i.status === 'FAILED_FINAL' && r.status === 'failed'],
  ]) {
    const pg = await db.identity.findMany({ where: { externalRef: { startsWith: prefix } } });
    const pgRuns = await db.taskRun.findMany({ where: { identityId: { in: pg.map((i) => i.id) } } });
    const pgById = new Map();
    for (const r of pgRuns) {
      if (!pgById.has(r.identityId)) pgById.set(r.identityId, []);
      pgById.get(r.identityId).push(r);
    }
    const badPg = [];
    for (const i of pg) {
      const rs = pgById.get(i.id) ?? [];
      if (rs.length !== 1 || !TERMINAL_RUN.includes(rs[0].status) || !okStatus(i, rs[0])) badPg.push(`${i.externalRef}:${i.status}/${rs[0]?.status ?? 'norun'}`);
    }
    record('P5', `${label}: ${pg.length} identities each exactly one terminal result`, pg.length === 6 && badPg.length === 0,
      badPg.slice(0, 4).join(' ') || 'all consistent');
  }

  // API log hygiene (no unhandled crashes)
  const apiL = apiLog();
  const crashes = (apiL.match(/UnhandledPromiseRejection|FATAL|boom/g) ?? []).length;
  record('P5', 'API log: no unhandled rejections / fatal crash markers', crashes === 0, `${crashes} markers`, { soft: true });
}

// ------------------------------------------------------------------ evidence
async function writeEvidence() {
  const hardFails = results.filter((r) => !r.pass && !r.soft);
  const batches = await db.batch.findMany({ orderBy: [{ createdAt: 'asc' }, { batchNo: 'asc' }] });
  const runs = await db.taskRun.findMany({ orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }] });
  const idents = await db.identity.findMany({ orderBy: { createdAt: 'asc' } });
  const leases = await db.resourceLease.findMany();
  const events = await db.taskRunEvent.findMany({ orderBy: { createdAt: 'asc' } });
  const tsv = (rows, cols) => [cols.join('\t'), ...rows.map((r) => cols.map((c) => {
    const v = r[c];
    return v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  }).join('\t'))].join('\n');
  writeFileSync(`${EVIDENCE}/db-batches.tsv`, tsv(batches, ['id', 'cycleId', 'batchNo', 'name', 'status', 'batchSize', 'maxActiveContainers', 'failurePolicy', 'startedAt', 'finishedAt']));
  writeFileSync(`${EVIDENCE}/db-taskruns.tsv`, tsv(runs.map((r) => ({ ...r, seq: /:a(\d+)$/.exec(r.idempotencyKey ?? '')?.[1] ?? '' })), ['id', 'batchId', 'identityId', 'seq', 'attempt', 'maxAttempts', 'status', 'errorCode', 'idempotencyKey', 'queuedAt', 'startedAt', 'finishedAt']));
  writeFileSync(`${EVIDENCE}/db-identities.tsv`, tsv(idents, ['id', 'externalRef', 'displayName', 'status']));
  writeFileSync(`${EVIDENCE}/db-leases-final.tsv`, tsv(leases, ['id', 'resourceType', 'resourceKey', 'ownerRunId', 'ownerLabel', 'leaseExpiresAt']));
  writeFileSync(`${EVIDENCE}/attempt-events.tsv`, tsv(events.map((e) => ({
    createdAt: e.createdAt, taskRunId: e.taskRunId, eventType: e.eventType,
    attempt: e.payloadJson?.attempt ?? '', message: e.message ?? '',
    payload: JSON.stringify(e.payloadJson ?? null).slice(0, 200),
  })), ['createdAt', 'taskRunId', 'eventType', 'attempt', 'message', 'payload']));
  writeFileSync(`${EVIDENCE}/lease-sampler.json`, JSON.stringify({
    intervalMs: 150, samples: leaseSamples.length,
    max: leaseSamples.reduce((m, s) => Math.max(m, s.n), 0),
    series: leaseSamples,
  }, null, 1));
  for (const p of ['api.log', 'api.err.log', 'worker1.log', 'worker1.err.log', 'worker2.log', 'worker2.err.log']) {
    if (existsSync(`${RUN}/${p}`)) copyFileSync(`${RUN}/${p}`, `${EVIDENCE}/${p}`);
  }
  const md = [
    '# BR-B6 E2E — MD §14.3 sandbox cycle (200 identities / 4 batches)',
    `generated: ${new Date().toISOString()}`,
    '',
    `**result: ${hardFails.length === 0 ? 'PASS' : 'FAIL'}** (${results.length - hardFails.length}/${results.length} checks; ${results.filter((r) => r.soft).length} soft)`,
    '',
    '## MD §14.3 item coverage',
    '',
    '| item | evidence |',
    '|---|---|',
    '| 1. preview 4×50 | P0 checks |',
    '| 2. active ≤ global cap | lease-sampler.json (150ms series, max ≤ 6) + overlap cycle |',
    '| 3. containers stopped, data retained | P5 heartbeat-log check + zero running managed |',
    '| 4. transient failure → retry + logs | P2 checks (docker kill mid-hold) |',
    '| 5. permanent failure → failure_policy | P4 checks (broken image, COMPLETED_WITH_ERRORS) |',
    '| 6. worker/API restart reconciliation | P3a/P3b checks (RECOVERING red line, orphan fix) |',
    '| 7. DB/Redis/Docker interruption | see report (hermetic coverage note) |',
    '| 8. 200 × exactly one final result | P5 checks + attempt-events.tsv uniqueness |',
    '',
    '## Checks',
    '',
    '| phase | check | result | detail |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.phase} | ${r.name} | ${r.pass ? 'PASS' : 'FAIL'}${r.soft ? ' (soft)' : ''} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '',
  ].join('\n');
  writeFileSync(`${EVIDENCE}/report.md`, md);
  writeFileSync(`${RUN}/report.md`, md);
  return hardFails;
}

// --------------------------------------------------------------------- main
async function main() {
  console.log(`[B6-E2E] start ${new Date().toISOString()}`);
  await db.$connect();
  await login();
  record('P0', 'admin login ok', true, 'brb6admin');

  // re-adopt the run.sh-owned API process
  const apiPid = Number(readFileSync(`${RUN}/pids/api`, 'utf8').trim());
  apiProc = handleFromPid(apiPid);
  const apiReady = await waitApiReady();
  if (!apiReady) throw new Error('API not ready at driver start');
  startWorker('1', { healthPort: 16344 });

  const cycleId = await phase0();
  await startMainCycle(cycleId);

  // P2 — transient failure: the injector runs CONCURRENTLY with phase1 (its
  // window is batch 1, the first minutes of the cycle — it must not be
  // The injector IIFE is launched BEFORE phase1 is awaited below, so it races
  // the live main cycle (stopIf = main cycle terminal).
  // Targets: brb6-007/017/027/037 (all batch 1). A kill is only USEFUL if it
  // lands while the run is still in-flight: the hold is 10s with 2s probes, so
  // a kill in the final probe gap (~2s before the deadline) can be missed —
  // the run succeeds on the same attempt. In that case move on to the next
  // target instead of recording a false PASS/FAIL (P(miss all 4) ≈ 0.2^4).
  // The injector gives up on a target once its run is terminal (window passed)
  // and aborts when the main cycle is terminal.
  const targets = ['brb6-007', 'brb6-017', 'brb6-027', 'brb6-037'].map((ref) => seed.main.find((m) => m.ref === ref));
  const injP = (async () => {
    for (const target of targets) {
      const r = await injectTransientFailure(target, () => (cycleTerminal(cycleId)));
      if (!r.killed) {
        if (r.windowPassed) continue;
        return r; // hard abort (cycle terminal)
      }
      // The kill landed — but did it hit in-flight work? If the run already
      // succeeded on the SAME attempt, the kill was too late (probe gap near
      // the deadline): try the next target.
      const chk = await waitFor('kill-effect check', async () => {
        const run = await db.taskRun.findUnique({ where: { id: r.runId } });
        return TERMINAL_RUN.includes(run?.status) ? run : null;
      }, { timeoutMs: 90_000 });
      const term = chk.v;
      if (term?.status === 'succeeded' && term.attempt <= r.attemptAtKill) continue;
      return r; // effective: retry (attempt+1) or hard failure
    }
    return { killed: false, lateAll: true };
  })();

  const phase1Res = await phase1(cycleId);
  const inj = await Promise.race([
    injP,
    sleep(5_000).then(() => ({ killed: false, late: true })), // phase1 already waited for main terminal
  ]);
  await assertTransientRecovery('P2', inj);

  // the main cycle must be fully terminal before the restart phase
  await waitFor('main cycle terminal', () => cycleTerminal(cycleId), { timeoutMs: 3_600_000, intervalMs: 1_000 });
  void phase1Res;

  // P3a/P3b need a LIVE cycle: a dedicated 6-id restart wave (the brb6-f
  // identities, still READY — the main cycle's ids are terminal and
  // re-rotation is illegal by design). Restarts are proven against a
  // running cycle, not a post-hoc one.
  const waveIds = (await db.identity.findMany({ where: { externalRef: { startsWith: 'brb6-f' } } })).map((i) => i.id);
  if (waveIds.length !== 6) throw new Error(`expected 6 restart-wave identities, got ${waveIds.length}`);
  const rc = await api('POST', '/api/batches', {
    body: {
      name: 'BR-B6 E2E restart-wave (P3 live cycle)',
      idempotencyKey: 'brb6-e2e-restartwave-20261022',
      identities: waveIds,
      batchSize: 6,
      maxActiveContainers: 4,
      failurePolicy: 'continue_and_report',
      config: { adapter: CONTAINER_SPEC },
    },
  });
  if (rc.status !== 201) throw new Error(`P3 restart-wave create failed: ${rc.status} ${rc.text.slice(0, 300)}`);
  const rcCycle = rc.json.cycleId;
  await ensureBatchStarted((await allBatchesOf(rcCycle))[0].id, 'P3 restart-wave batch 1');

  // wait until the wave is genuinely in-flight (≥2 live containers) BEFORE
  // touching the API — the restart must hit a running cycle
  await waitFor('wave live for API restart', async () => (await runningManagedCount()) >= 2, { timeoutMs: 600_000 });
  await phase3aApiRestart();
  await phase3bWorkerKill();

  // the restart wave must still reach a terminal state: victims (the
  // in-flight runs at the kill) → CANCELLED; the rest → SUCCEEDED.
  const waveWait = await waitFor('restart wave terminal', () => cycleTerminal(rcCycle), { timeoutMs: 1_800_000, intervalMs: 1_000 });
  const waveBatch = (await allBatchesOf(rcCycle))[0];
  const waveRuns = await db.taskRun.findMany({ where: { batchId: waveBatch.id } });
  const waveIdents = await db.identity.findMany({ where: { id: { in: waveIds } } });
  const waveRunsById = new Map();
  for (const r of waveRuns) {
    if (!waveRunsById.has(r.identityId)) waveRunsById.set(r.identityId, []);
    waveRunsById.get(r.identityId).push(r);
  }
  const waveExactlyOne = waveRunsById.size === 6 && [...waveRunsById.values()].every((rs2) => rs2.length === 1 && rs2.every((r) => TERMINAL_RUN.includes(r.status)));
  record('P3', 'restart wave: all 6 identities exactly ONE terminal result (victims cancelled, rest succeeded)',
    !waveWait.timedOut && waveExactlyOne && waveRuns.some((r) => r.status === 'cancelled') && waveRuns.some((r) => r.status === 'succeeded'),
    waveRuns.map((r) => r.status).join(',') + ` batch=${waveBatch.status}`);
  // B1 completion rule (delivered): only FAILED_FINAL counts as a batch
  // error; CANCELLED (quarantine) is a plain terminal → the wave converges
  // COMPLETED. (COMPLETED_WITH_ERRORS would require a FAILED_FINAL.)
  record('P3', 'restart wave batch converged (all members terminal; no wedge)',
    ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(waveBatch.status), `batch=${waveBatch.status}`);
  void waveIdents;

  // P4: permanent failure needs 6 identities that are NOT yet terminal
  // (brb6-f are terminal after the wave). Deterministic runtime seed
  // brb6-g01..06 (DB-level, like seed.js — the identities API route is
  // B5's surface and not needed for a throwaway harness cycle).
  const p4idents = [];
  for (let i = 1; i <= 6; i += 1) {
    const ref = `brb6-g${String(i).padStart(2, '0')}`;
    const id = cryptoRandomUuid(ref);
    mkdirSync(`${RUN}/data/${ref}`, { recursive: true });
    await db.identity.create({ data: { id, externalRef: ref, displayName: `BR-B6 P4 ${ref} (broken image)`, status: 'READY', dataPath: path.resolve(`${RUN}/data/${ref}`), identityType: 'qa_device' } });
    p4idents.push(id);
  }
  await runPhase4With(p4idents);

  await phase5(cycleId);

  const hardFails = await writeEvidence();
  console.log(`[B6-E2E] done ${new Date().toISOString()} — hard fails: ${hardFails.length}`);
  await db.$disconnect();
  process.exit(hardFails.length === 0 ? 0 : 1);
}

// P4 with explicit ids (the phase4 above assumed brb6-f; re-targeted here).
async function runPhase4With(brokenIds) {
  const bc = await api('POST', '/api/batches', {
    body: {
      name: 'BR-B6 E2E permanent-failure cycle (broken image)',
      idempotencyKey: 'brb6-e2e-broken-20261022',
      identities: brokenIds,
      batchSize: 6,
      maxActiveContainers: 6,
      failurePolicy: 'continue_and_report',
      config: { adapter: { type: 'container', image: BROKEN_IMAGE, health: { kind: 'adb-tcp', port: 5555 }, work: { kind: 'hold', durationMs: 2000 } }, maxAttempts: 3 },
    },
  });
  if (bc.status !== 201) throw new Error(`P4 create failed: ${bc.status} ${bc.text.slice(0, 300)}`);
  await ensureBatchStarted((await allBatchesOf(bc.json.cycleId))[0].id, 'P4 broken cycle batch 1');
  const { timedOut } = await waitFor('broken cycle terminal', () => cycleTerminal(bc.json.cycleId), { timeoutMs: 900_000, intervalMs: 1_000 });
  const batch = (await allBatchesOf(bc.json.cycleId))[0];
  const runs = await db.taskRun.findMany({ where: { batchId: batch.id } });
  record('P4', 'permanent failure: batch → COMPLETED_WITH_ERRORS (failure_policy honored)', !timedOut && batch.status === 'COMPLETED_WITH_ERRORS',
    `status=${batch.status} (timedOut=${timedOut})`);
  const allFailedFinal = runs.length === 6 && runs.every((r) => r.status === 'failed' && r.attempt >= 3 && r.errorCode);
  record('P4', 'all 6 runs FAILED after exhausting maxAttempts=3 (real retries, real error codes)', allFailedFinal,
    runs.map((r) => `${r.status}@a${r.attempt}:${(r.errorCode ?? '').slice(0, 20)}`).join(' | ').slice(0, 240));
  // The 'failed' event message is the fixed string "run failed" — the cause
  // lives in the run's errorMessage (each of the 6 runs ends at attempt 3
  // with the API's ADB-handshake-timeout error: "...the ADB handshake did
  // not answer within the health window...").
  const handshakeRuns = runs.filter((r) => String(r.errorMessage ?? '').includes('handshake')).length;
  record('P4', 'failure cause logged (ADB handshake timeout in run error)', handshakeRuns >= 6, `${handshakeRuns}/6 runs carry the handshake-timeout error`);
}

function cryptoRandomUuid(seedStr) {
  // deterministic v4-shaped uuid from a tag (same scheme as seed.js; plain
  // number math — w ≤ 12 keeps 2**48 < MAX_SAFE_INTEGER)
  let h = 0x811c9dc5;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const hex = (n, w = 8) => (n % 2 ** (w * 4)).toString(16).padStart(w, '0');
  return `${hex(h, 8)}-${hex(h + 1, 4)}-4${hex(h + 2, 3)}-8${hex(h + 3, 3)}-${hex(h + 4, 12)}`;
}

main().catch(async (err) => {
  console.error('[B6-E2E] DRIVER CRASH:', err);
  try {
    const md = ['# BR-B6 E2E — DRIVER CRASH', `at ${new Date().toISOString()}`, '', String(err?.stack ?? err), '', '## Checks so far', '', ...results.map((r) => `- [${r.phase}] ${r.pass ? 'PASS' : 'FAIL'}${r.soft ? ' (soft)' : ''} — ${r.name}${r.detail ? ` (${r.detail})` : ''}`)].join('\n');
    writeFileSync(`${EVIDENCE}/report-crash.md`, md);
  } catch { /* best effort */ }
  process.exit(2);
});
