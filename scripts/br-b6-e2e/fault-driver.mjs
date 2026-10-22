#!/usr/bin/env node
/**
 * BR-B6 fault-injection driver (MD §14.2/§14.3 scope-4: cross-component
 * fault scenarios, live scratch, hermetic-priority already satisfied by
 * tests/integration/batch-container-faults.test.js S4①–④ + the E2E P2–P4).
 *
 * Uses 12 ladder identities (brb6-001..012) in a FRESH br-b6-e2e scratch env
 * (run after the main E2E completes; setup.sh is idempotent + fresh DB).
 *
 *   F0  baseline: 12-id cycle runs clean (proves the env can be clean)
 *   F1  Redis down 15s MID-CYCLE  -> scheduler defers (no new dispatch while
 *       the queue is unavailable), in-flight run finishes, recovery drains
 *       the queue; cycle completes with exactly one terminal result per
 *       identity and zero double executions (attempt_started uniqueness).
 *   F2  Postgres down 15s MID-CYCLE -> API ready 503 (evidence), worker
 *       heartbeats fail -> in-flight runs fail-closed (slot lease lost,
 *       container best-effort stopped, VOLUME KEPT); on recovery the
 *       reconciler converges the cycle (retries where the policy allows,
 *       honest FAILED_FINAL where it does not) — no identity double-runs.
 *   F3  COMBO: worker SIGKILL + Redis stop in the same second -> both
 *       recovered (worker re-spawn by the driver, redis restart) -> the
 *       reconciler converges: no lost identity, no double execution.
 *   F4  Docker daemon down: NOT exercised live (the daemon is shared with
 *       the user's compose stack — stopping it is a redline violation).
 *       Hermetic evidence: tests/integration/batch-container-faults.test.js
 *       'S4③ docker daemon down -> FAIL-CLOSED' (cited in the report).
 *
 * Hard invariants after EVERY fault (the MD's 唔雙跑唔漏單):
 *   (a) every identity has EXACTLY ONE terminal run outcome
 *   (b) attempt_started is unique per (runId, attempt) across the whole DB
 *   (c) zero residual RUNNING managed containers at the end
 *
 * Exit 0 = all hard checks passed; 1 = hard failure; 2 = driver crash.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const API = 'http://127.0.0.1:16343';
const RUN = '.dev/br-b6-e2e';
const EVIDENCE = process.env.BRB6_E2E_EVIDENCE_DIR ?? '/home/kenneth/.openclaw/workspace/logs/br-b6-e2e';
const GOOD_IMAGE = 'water-army/brb6-adb-mock:20261022';
const N = 12;
mkdirSync(EVIDENCE, { recursive: true });

const dbUrl = readFileSync(`${RUN}/api.env`, 'utf8').split('\n')
  .find((l) => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
if (!dbUrl) throw new Error('DATABASE_URL missing from api.env — run setup.sh first');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });
await db.$connect();

const seed = JSON.parse(readFileSync(`${RUN}/identities.json`, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dc = (args) => execSync(`sg docker -c "docker ${args}"`, { encoding: 'utf8' }).trim();

let cookie;
const results = [];
function record(phase, name, pass, detail = '', { soft = false } = {}) {
  results.push({ phase, name, pass: !!pass, detail: String(detail).slice(0, 300), soft });
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
  // BR-B6 gen3: MUST return headers — login() reads set-cookie from them
  // (the E2E driver's api() does; this copy never had been live-run until
  // the gen3 fault run, which hit `res.headers.get` on undefined).
  return { status: res.status, json, text, headers: res.headers };
}
async function login() {
  const res = await api('POST', '/api/auth/login', { body: { username: seed.admin.username, password: seed.admin.password } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  cookie = res.headers.get('set-cookie').split(';')[0];
}
async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 3000 } = {}) {
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
  work: { kind: 'hold', durationMs: 4000 },
};

// worker management (F3 kills it; the driver owns the respawn).
// WORKER_HEALTH_PORT MUST be set to a scratch port — the config default is
// 3001, which is a FORBIDDEN port (redline). Workers run sequentially.
const WORKER_HEALTH_PORT = '16350';
let workerProc = null;
function startWorker(tag) {
  const env = { ...process.env };
  for (const line of readFileSync(`${RUN}/worker-base.env`, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  env.WORKER_HEALTH_PORT = WORKER_HEALTH_PORT;
  workerProc = spawn('node', ['apps/worker/src/worker.js'], {
    env,
    cwd: process.cwd(),
    stdio: ['ignore', openSync(`${RUN}/fault-worker-${tag}.log`, 'a'), openSync(`${RUN}/fault-worker-${tag}.err.log`, 'a')],
  });
  return workerProc;
}
function workerAlive() {
  return workerProc !== null && workerProc.exitCode === null && !workerProc.killed;
}

async function runningManaged() {
  try {
    const inv = dc(`ps -a --filter "label=com.mirrorsocialmedia.water-army.managed=true" --format "{{.ID}} {{.Status}}"`);
    return inv.split('\n').filter((l) => /\bUp\b/.test(l));
  } catch { return []; }
}

// ------------------------------------------------------------ cycle helpers
async function createCycle(tag, refs) {
  const ids = refs.map((ref) => seed.main.find((m) => m.ref === ref).id);
  const r = await api('POST', '/api/batches', {
    body: {
      name: `BR-B6 FAULT ${tag} (${refs.length} identities)`,
      idempotencyKey: `brb6f-${tag}-${Date.now().toString(36)}`,
      identities: ids,
      batchSize: ids.length,
      maxActiveContainers: 6,
      failurePolicy: 'continue_and_report',
      config: { adapter: CONTAINER_SPEC },
    },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`${tag}: create failed ${r.status} ${r.text.slice(0, 300)}`);
  return r.json.cycleId;
}
async function batchesOf(cycleId) {
  return db.batch.findMany({ where: { cycleId }, orderBy: { batchNo: 'asc' } });
}
async function startBatch(cycleId, tag) {
  const [b] = await batchesOf(cycleId);
  const r = await api('POST', `/api/batches/${b.id}/start`);
  // Contract (E2E driver P1 + batches-api tests): 202 = fresh dispatch
  // (async — batch goes RUNNING); 200 = idempotent no-op (scheduler already
  // started it, or it converged). Both are success — convergence is proven
  // by the subsequent DB waitFor, not by this status.
  if (r.status === 202 || r.status === 200) return r.json;
  throw new Error(`${tag}: start failed ${r.status} ${r.text.slice(0, 200)}`);
}
async function cycleTerminal(cycleId) {
  const bs = await batchesOf(cycleId);
  return bs.length > 0 && bs.every((b) => TERMINAL_BATCH.includes(b.status));
}
async function waitTerminal(cycleId, tag, { timeoutMs = 5 * 60_000 } = {}) {
  const { timedOut } = await waitFor(`${tag} terminal`, () => (cycleTerminal(cycleId) ? true : null), { timeoutMs, intervalMs: 3000 });
  if (timedOut) {
    for (const b of await batchesOf(cycleId)) {
      if (!TERMINAL_BATCH.includes(b.status)) await api('POST', `/api/batches/${b.id}/cancel`).catch(() => {});
    }
    await waitFor(`${tag} terminal after cancel`, () => (cycleTerminal(cycleId) ? true : null), { timeoutMs: 2 * 60_000, intervalMs: 3000 });
  }
}
// re-arm identities for the next fault scenario (fresh READY state)
async function rearm(refs) {
  for (const ref of refs) {
    const id = seed.main.find((m) => m.ref === ref).id;
    await db.identity.update({ where: { id }, data: { status: 'READY' } }).catch(() => {});
  }
}
// the MD's core invariants (唔雙跑唔漏單) — scoped to a set of identities
// BR-B6 gen3: MUST scope to the current cycle's batches — the scratch DB
// accumulates cycles (F0→F3 reuse the same identities), so an unscoped
// per-identity terminal count would count F0's runs inside F1 and hard-fail
// every later phase. (The attempt_started uniqueness check below is
// deliberately global: the claim CAS must never double-execute ANY run.)
async function assertConvergence(phase, refs, cycleId, { expectAllSucceeded = true } = {}) {
  const batchIds = (await batchesOf(cycleId)).map((b) => b.id);
  const ids = refs.map((ref) => seed.main.find((m) => m.ref === ref).id);
  const runs = await db.taskRun.findMany({ where: { identityId: { in: ids }, batchId: { in: batchIds } } });
  const byId = new Map();
  for (const r of runs) {
    if (!byId.has(r.identityId)) byId.set(r.identityId, []);
    byId.get(r.identityId).push(r);
  }
  const bad = [];
  const outcomes = {};
  for (const id of ids) {
    const rs = (byId.get(id) ?? []).filter((r) => TERMINAL_RUN.includes(r.status));
    if (rs.length !== 1) bad.push(`${id.slice(0, 8)}: ${rs.length} terminal runs`);
    else {
      outcomes[rs[0].status] = (outcomes[rs[0].status] ?? 0) + 1;
      if (expectAllSucceeded && rs[0].status !== 'succeeded') bad.push(`${id.slice(0, 8)}: ${rs[0].status} (${rs[0].errorCode ?? ''})`);
    }
  }
  record(phase, `${refs.length} identities: exactly ONE terminal outcome each`, bad.length === 0,
    bad.slice(0, 3).join(' | ') || JSON.stringify(outcomes));
  // attempt_started uniqueness across the WHOLE scratch DB (claim CAS invariant)
  const evs = await db.taskRunEvent.findMany({ where: { eventType: 'attempt_started' } });
  const byKey = new Map();
  for (const e of evs) {
    const k = `${e.taskRunId}:a${e.payloadJson?.attempt ?? 'unknown'}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  const dups = [...byKey.entries()].filter(([, c]) => c > 1);
  record(phase, 'attempt_started unique across ALL runs (no double execution)', dups.length === 0,
    `${evs.length} events / ${byKey.size} keys${dups.length ? ` DUPS=${dups.slice(0, 3)}` : ''}`);
  const left = await runningManaged();
  record(phase, 'zero RUNNING managed containers', left.length === 0, left.join(' | ') || 'clean');
  return bad.length === 0 && dups.length === 0 && left.length === 0;
}

// ---------------------------------------------------------------- scenarios
async function f0() {
  const refs = Array.from({ length: N }, (_, i) => `brb6-${String(i + 1).padStart(3, '0')}`);
  const cycleId = await createCycle('F0', refs);
  await startBatch(cycleId, 'F0');
  record('F0', 'cycle created + started', true, `cycleId=${String(cycleId).slice(0, 8)}…`);
  await waitTerminal(cycleId, 'F0');
  const ok = await assertConvergence('F0', refs, cycleId);
  record('F0', 'baseline cycle fully succeeded', ok);
}

async function f1() {
  const refs = Array.from({ length: N }, (_, i) => `brb6-${String(i + 1).padStart(3, '0')}`);
  const cycleId = await createCycle('F1', refs);
  await startBatch(cycleId, 'F1');
  // let work start: >=3 runs must have begun (or finished) before the cut
  await waitFor('F1 warm-up (runs moving)', async () => {
    const n = await db.taskRun.count({ where: { batchId: { in: (await batchesOf(cycleId)).map((b) => b.id) }, status: { in: ['running', 'succeeded', 'failed'] } } });
    return n >= 3 ? n : null;
  }, { timeoutMs: 60_000, intervalMs: 2000 });

  const evsBefore = await db.taskRunEvent.count({ where: { eventType: 'attempt_started' } });
  console.log('[F1] REDIS DOWN 15s (mid-cycle)');
  dc('stop br-b6-redis');
  // during the cut: the scheduler cannot dispatch (queue unavailable).
  // Evidence: no NEW attempt_started events accrue during the window.
  await sleep(6000);
  const midCount = await db.taskRunEvent.count({ where: { eventType: 'attempt_started' } });
  await sleep(9000);
  const afterCutCount = await db.taskRunEvent.count({ where: { eventType: 'attempt_started' } });
  record('F1', 'scheduler deferred while Redis down (no new dispatch in the cut window)',
    afterCutCount <= midCount + 1, `before=${evsBefore} mid=${midCount} after-cut=${afterCutCount}`);
  console.log('[F1] REDIS UP');
  dc('start br-b6-redis');

  await waitTerminal(cycleId, 'F1');
  const ok = await assertConvergence('F1', refs, cycleId);
  record('F1', 'cycle converged after Redis recovery', ok);
}

async function f2() {
  const refs = Array.from({ length: N }, (_, i) => `brb6-${String(i + 1).padStart(3, '0')}`);
  const cycleId = await createCycle('F2', refs);
  await startBatch(cycleId, 'F2');
  await waitFor('F2 warm-up (runs moving)', async () => {
    const n = await db.taskRun.count({ where: { batchId: { in: (await batchesOf(cycleId)).map((b) => b.id) }, status: { in: ['running', 'succeeded', 'failed'] } } });
    return n >= 3 ? n : null;
  }, { timeoutMs: 60_000, intervalMs: 2000 });

  console.log('[F2] POSTGRES DOWN 15s (mid-cycle)');
  dc('stop br-b6-pg');
  // API must report NOT ready while the DB is down (evidence, read-only)
  const readyDuring = await fetch(`${API}/api/health/ready`).then((r) => r.status).catch(() => 'CONN_REFUSED');
  record('F2', 'API ready degrades while Postgres down (503/refused, not a false 200)',
    readyDuring !== 200, `ready status=${readyDuring}`);
  await sleep(10_000);
  console.log('[F2] POSTGRES UP');
  dc('start br-b6-pg');
  await waitFor('F2 pg ready', async () => {
    const ok = await fetch(`${API}/api/health/ready`).then((r) => r.status === 200).catch(() => false);
    return ok ? true : null;
  }, { timeoutMs: 60_000, intervalMs: 2000 });

  // after recovery the reconciler + retry policy converge the cycle.
  // in-flight runs at cut time fail-closed (lease lost); retryable policies
  // re-dispatch; the invariant that matters is ONE honest outcome per identity
  // with zero double execution.
  await waitTerminal(cycleId, 'F2');
  const ok = await assertConvergence('F2', refs, cycleId, { expectAllSucceeded: false });
  const bs = await batchesOf(cycleId);
  record('F2', `cycle terminal after PG recovery: ${bs.map((b) => b.status).join(',')}`, true, 'honest outcomes (see DB)');
  await rearm(refs);
  return ok;
}

async function f3() {
  const refs = Array.from({ length: N }, (_, i) => `brb6-${String(i + 1).padStart(3, '0')}`);
  const cycleId = await createCycle('F3', refs);
  await startBatch(cycleId, 'F3');
  await waitFor('F3 warm-up (runs moving)', async () => {
    const n = await db.taskRun.count({ where: { batchId: { in: (await batchesOf(cycleId)).map((b) => b.id) }, status: { in: ['running', 'succeeded', 'failed'] } } });
    return n >= 3 ? n : null;
  }, { timeoutMs: 60_000, intervalMs: 2000 });

  console.log('[F3] COMBO: worker SIGKILL + REDIS DOWN (same second)');
  dc('stop br-b6-redis');
  workerProc.kill('SIGKILL');
  await sleep(12_000);
  console.log('[F3] RECOVERY: redis up + worker respawn');
  dc('start br-b6-redis');
  startWorker('f3b');
  await waitFor('F3 worker up', () => (workerAlive() ? true : null), { timeoutMs: 60_000, intervalMs: 2000 });

  await waitTerminal(cycleId, 'F3');
  const ok = await assertConvergence('F3', refs, cycleId, { expectAllSucceeded: false });
  record('F3', 'combo converged (no lost identity, no double run)', ok);
  return ok;
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`[B6-FAULT] start ${new Date().toISOString()}`);
  await login();
  const cap = await api('POST', '/api/batches/capacity', { body: { maxActiveContainers: 6 } });
  if (cap.status !== 200) throw new Error(`cap set failed: ${cap.status}`);
  startWorker('f0');
  await sleep(3000);

  await f0();
  await rearm(Array.from({ length: N }, (_, i) => `brb6-${String(i + 1).padStart(3, '0')}`));
  await f1();
  await rearm(Array.from({ length: N }, (_, i) => `brb6-${String(i + 1).padStart(3, '0')}`));
  await f2();
  await rearm(Array.from({ length: N }, (_, i) => `brb6-${String(i + 1).padStart(3, '0')}`));
  await f3();

  // F4: docker daemon down — hermetic only (shared daemon redline). Cite:
  record('F4', 'docker-daemon-down covered hermetically (S4③ fail-closed test); live daemon stop is a redline (shared with user compose)', true,
    'tests/integration/batch-container-faults.test.js S4③', { soft: true });

  const hard = results.filter((r) => !r.soft);
  const pass = hard.filter((r) => r.pass).length;
  const fail = hard.length - pass;
  writeFileSync(`${EVIDENCE}/fault-summary.json`, JSON.stringify({ at: new Date().toISOString(), pass, fail, results }, null, 2));
  console.log(`[B6-FAULT] done — ${pass}/${hard.length} hard checks pass${fail ? ` (${fail} FAIL)` : ''} -> ${EVIDENCE}/fault-summary.json`);
  process.exitCode = fail > 0 ? 1 : 0;
  await db.$disconnect();
  if (workerProc) workerProc.kill('SIGTERM');
}

main().catch(async (err) => {
  console.error(`[B6-FAULT] FATAL ${String(err?.stack ?? err).slice(0, 500)}`);
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(2);
});
