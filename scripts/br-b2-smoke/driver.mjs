/**
 * BR-B2 G8 — live smoke driver (host node, against the 163xx scratch stack).
 *
 * G8 requirement → phase map (MD §14.2, 5 identity / maxActive=2, noop adapter):
 *
 *   A: 5 identities, batchSize 5, maxActive 2, TWO scheduler replicas (W1+W2)
 *      1. active never >2 — 150ms DB lease sampler (point-in-time resource_lease
 *         counts for the whole run) + per-phase API activeCount peaks
 *      2. all 5 identities reach COMPLETED
 *      5. two schedulers tick simultaneously without duplicate enqueue:
 *         exactly 5 task_run rows (not 10), all attempt=1, exactly one
 *         attempt_started per run, both replicas provably scheduler-on and
 *         job-consuming
 *   B: pause {stopExisting:false} mid-run (MD §7.1: pause 只禁止新派發)
 *      3. running NOT killed (runs running at pause land succeeded),
 *         queued dispatch stopped (pause's own sync cancel + zero
 *         attempt_started after the pause timestamp), resume re-arms and
 *         completes the cycle
 *   C: kill -9 W2 mid-cycle with BOTH workers at steady state (concurrency=1
 *      per worker ⇒ pigeonhole: the 2 running runs sit on 2 different workers)
 *      4a. the surviving replica's scheduler reconciles the orphan via the
 *         lease-expiry path (exactly one EXECUTOR_LOST on the killed worker's
 *         run, the other run completes untouched), no double execution
 *   D: deterministic orphan: stop the survivor, solo worker W3 runs a
 *      batchSize-1 cycle (3 sequential batches — progressCycles auto-progression
 *      is exercised for real), kill -9 W3 mid-run, boot W4:
 *      4b. lease-expired reconciliation (EXECUTOR_LOST → retry attempt →
 *          success), all 3 batches COMPLETED, zero live leases,
 *          batch #2/#3 started by the scheduler (startedAt > prev finishedAt)
 *
 *   Global: no double execution — every (runId, attempt) has EXACTLY ONE
 *          attempt_started event in the whole scratch DB (claim CAS live proof).
 *
 * Evidence: $B2_SMOKE_EVIDENCE_DIR (default /home/kenneth/.openclaw/workspace/logs/br-b2-g8-evidence).
 * Exit 0 = all hard checks passed; 1 = hard failure; 2 = driver crash.
 */
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, openSync, existsSync,
} from 'node:fs';
import { spawn } from 'node:child_process';

const { PrismaClient } = await import('@prisma/client');
const { PrismaPg } = await import('@prisma/adapter-pg');

const API = 'http://127.0.0.1:16323';
const RUN = '.dev/br-b2-smoke';
const EVIDENCE = process.env.B2_SMOKE_EVIDENCE_DIR
  || '/home/kenneth/.openclaw/workspace/logs/br-b2-g8-evidence';
mkdirSync(EVIDENCE, { recursive: true });

const seed = JSON.parse(readFileSync(`${RUN}/identities.json`, 'utf8'));
const dbUrl = readFileSync(`${RUN}/api.env`, 'utf8').split('\n')
  .find((l) => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
if (!dbUrl) throw new Error('DATABASE_URL missing from api.env');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });
await db.$connect();

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
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smokeadmin', password: seed.password }),
  });
  if (res.status !== 200) throw new Error(`smoke login failed: ${res.status} ${await res.text()}`);
  cookie = res.headers.get('set-cookie').split(';')[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeoutMs = 90_000, intervalMs = 300 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

async function batchDetail(id) {
  const r = await api('GET', `/api/batches/${id}?runsLimit=100`);
  if (r.status !== 200) throw new Error(`batch detail ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json;
}
const TERMINAL_BATCH = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED', 'FAILED'];
const TERMINAL_RUN = ['succeeded', 'failed', 'timed_out', 'cancelled'];

async function createAndStartCycle(phase, group, batchSize, maxActive) {
  const ids = seed.groups[group];
  const key = `smoke-${phase}-${Date.now().toString(36)}`.slice(0, 24);
  const create = await api('POST', '/api/batches', {
    body: {
      name: `smoke ${phase}`,
      idempotencyKey: key,
      identities: ids,
      batchSize,
      maxActiveContainers: maxActive,
      failurePolicy: 'continue_and_report',
    },
  });
  if (create.status !== 201) throw new Error(`${phase} create failed: ${create.status} ${create.text.slice(0, 300)}`);
  const cycle = create.json;
  const first = cycle.batches[0];
  const start = await api('POST', `/api/batches/${first.id}/start`);
  if (start.status !== 202) throw new Error(`${phase} start failed: ${start.status} ${start.text.slice(0, 300)}`);
  return { cycle, batchId: first.id, batchCount: cycle.batches.length };
}

/** Wait for one batch to be terminal (batch status + every run terminal). Tracks API activeCount peak. */
async function waitCycleTerminal(phase, batchId, timeoutMs = 120_000) {
  let peak = 0;
  const t0 = Date.now();
  for (;;) {
    const d = await batchDetail(batchId);
    peak = Math.max(peak, d.activeCount ?? 0);
    const batchTerminal = TERMINAL_BATCH.includes(d.batch.status);
    const allRunsTerminal = d.runs.length > 0 && d.runs.every((r) => TERMINAL_RUN.includes(r.status));
    if (batchTerminal && allRunsTerminal) return { d, peak, timedOut: false, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { d, peak, timedOut: true, elapsedMs: Date.now() - t0 };
    await sleep(300);
  }
}

/** Wait for EVERY batch of the cycle to be terminal (multi-batch phases). */
async function waitAllCycleBatches(phase, batchIds, timeoutMs = 180_000) {
  const t0 = Date.now();
  for (;;) {
    const all = [];
    let done = true;
    for (const id of batchIds) {
      const d = await batchDetail(id);
      all.push(d);
      const ok = TERMINAL_BATCH.includes(d.batch.status)
        && d.runs.length > 0 && d.runs.every((r) => TERMINAL_RUN.includes(r.status));
      if (!ok) done = false;
    }
    if (done) return { all, timedOut: false, elapsedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { all, timedOut: true, elapsedMs: Date.now() - t0 };
    await sleep(300);
  }
}

const slotLeaseCount = () => db.resourceLease.count({ where: { resourceType: 'container_slot' } });
const liveRuns = () => db.taskRun.count({ where: { status: { in: ['running', 'queued', 'cancel_requested'] } } });

/** attempt_started uniqueness: every (runId, attempt) exactly once — the claim CAS invariant. */
async function attemptStartedUniqueness() {
  const evs = await db.taskRunEvent.findMany({ where: { eventType: 'attempt_started' }, orderBy: { createdAt: 'asc' } });
  const byKey = new Map();
  for (const e of evs) {
    const attempt = e.payloadJson?.attempt ?? 'unknown';
    const k = `${e.taskRunId}:a${attempt}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  const dups = [...byKey.entries()].filter(([, c]) => c > 1);
  return { total: evs.length, groups: byKey.size, dups };
}

// --- background DB lease sampler (G8 req 1: point-in-time lease count series) ---
const leaseSamples = [];
let samplerTimer = null;
function startLeaseSampler(intervalMs = 150) {
  samplerTimer = setInterval(() => {
    db.resourceLease.count({ where: { resourceType: 'container_slot' } })
      .then((n) => leaseSamples.push({ t: Date.now(), n }))
      .catch(() => { /* transient — keep sampling */ });
  }, intervalMs);
  if (typeof samplerTimer.unref === 'function') samplerTimer.unref();
}
function stopLeaseSampler() {
  if (samplerTimer) clearInterval(samplerTimer);
  samplerTimer = null;
  return leaseSamples.reduce((m, s) => Math.max(m, s.n), 0);
}

// --- worker process management -----------------------------------------------
const workers = new Map(); // name -> {pid, proc, exited?}
function startWorker(name, { healthPort, scheduler }) {
  const tag = `B2SMOKE_W${name}`;
  for (const suffix of ['', '.err']) rmSync(`${RUN}/worker${name}${suffix}.log`, { force: true }); // stale-log hygiene
  const envLines = readFileSync(`${RUN}/worker-base.env`, 'utf8').split('\n').filter(Boolean);
  const env = { ...process.env };
  for (const line of envLines) {
    const i = line.indexOf('=');
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  env.WORKER_HEALTH_PORT = String(healthPort);
  env.BATCH_SCHEDULER_ENABLED = String(scheduler);
  env.SMOKE_TAG = tag;
  const log = spawn('node', ['apps/worker/src/worker.js'], {
    env,
    stdio: ['ignore', openSync(`${RUN}/worker${name}.log`, 'a'), openSync(`${RUN}/worker${name}.err.log`, 'a')],
  });
  log.on('exit', (code, sig) => {
    console.log(`[worker:${name}] exited code=${code} sig=${sig}`);
  });
  workers.set(name, { pid: log.pid, proc: log });
  mkdirSync(`${RUN}/pids`, { recursive: true });
  writeFileSync(`${RUN}/pids/w${name}`, String(log.pid));
  return log.pid;
}
async function waitWorkerDrain(name, timeoutMs = 25_000) {
  const w = workers.get(name);
  if (!w) return true;
  const t0 = Date.now();
  for (;;) {
    if (w.proc.exitCode !== null || w.proc.signalCode) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(250);
  }
}
async function stopWorker(name) {
  const w = workers.get(name);
  if (!w || w.proc.exitCode !== null) return;
  w.proc.kill('SIGTERM');
  await waitWorkerDrain(name);
}
function kill9(name) {
  const w = workers.get(name);
  if (!w || w.proc.exitCode !== null) return false;
  w.proc.kill('SIGKILL');
  return true;
}
const workerLog = (name) => {
  const p = `${RUN}/worker${name}.log`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

// --- evidence ------------------------------------------------------------------
async function writeEvidence({ phaseNote = '' } = {}) {
  try {
    const samplerMax = samplerTimer ? leaseSamples.reduce((m, s) => Math.max(m, s.n), 0) : null;
    const batches = await db.batch.findMany({ orderBy: [{ createdAt: 'asc' }, { batchNo: 'asc' }] });
    const runs = await db.taskRun.findMany({ where: { batchId: { in: batches.map((b) => b.id) } }, orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }] });
    const idents = await db.identity.findMany({ orderBy: { createdAt: 'asc' } });
    const leases = await db.resourceLease.findMany({ where: { resourceType: 'container_slot' } });
    const events = await db.taskRunEvent.findMany({
      where: { taskRunId: { in: runs.map((r) => r.id) } },
      orderBy: { createdAt: 'asc' },
    });

    const tsv = (rows, cols) => [cols.join('\t'), ...rows.map((r) => cols.map((c) => {
      const v = r[c];
      return v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    }).join('\t'))].join('\n');

    writeFileSync(`${EVIDENCE}/db-batches.tsv`, tsv(batches, ['id', 'cycleId', 'batchNo', 'name', 'status', 'batchSize', 'maxActiveContainers', 'failurePolicy', 'startedAt', 'finishedAt']));
    writeFileSync(`${EVIDENCE}/db-taskruns.tsv`, tsv(runs.map((r) => ({ ...r, seq: /:a(\d+)$/.exec(r.idempotencyKey ?? '')?.[1] ?? '' })), ['id', 'batchId', 'identityId', 'seq', 'attempt', 'maxAttempts', 'status', 'errorCode', 'idempotencyKey', 'queuedAt', 'startedAt', 'finishedAt']));
    writeFileSync(`${EVIDENCE}/db-identities.tsv`, tsv(idents, ['id', 'externalRef', 'displayName', 'status']));
    writeFileSync(`${EVIDENCE}/db-leases-final.tsv`, tsv(leases, ['id', 'resourceType', 'resourceKey', 'ownerRunId', 'ownerLabel', 'leaseExpiresAt']));
    writeFileSync(`${EVIDENCE}/attempt-events.tsv`, tsv(
      events.map((e) => ({
        createdAt: e.createdAt,
        taskRunId: e.taskRunId,
        eventType: e.eventType,
        attempt: e.payloadJson?.attempt ?? '',
        message: e.message ?? '',
        payload: JSON.stringify(e.payloadJson ?? null).slice(0, 200),
      })),
      ['createdAt', 'taskRunId', 'eventType', 'attempt', 'message', 'payload'],
    ));
    writeFileSync(`${EVIDENCE}/lease-sampler.json`, JSON.stringify({
      intervalMs: 150,
      samples: leaseSamples.length,
      max: samplerMax,
      first: leaseSamples[0] ?? null,
      last: leaseSamples.at(-1) ?? null,
      series: leaseSamples,
    }, null, 1));
    for (const n of ['1', '2', '3', '4']) {
      for (const suffix of ['', '.err']) {
        const p = `${RUN}/worker${n}${suffix}.log`;
        if (existsSync(p)) copyFileSync(p, `${EVIDENCE}/worker${n}${suffix}.log`);
      }
    }
    if (existsSync(`${RUN}/api.log`)) copyFileSync(`${RUN}/api.log`, `${EVIDENCE}/api.log`);

    const hardFails = results.filter((r) => !r.pass && !r.soft);
    const md = [
      '# BR-B2 G8 live smoke report',
      `generated: ${new Date().toISOString()}${phaseNote ? ` | ${phaseNote}` : ''}`,
      '',
      `**result: ${hardFails.length === 0 ? 'PASS' : 'FAIL'}** (${results.length - hardFails.length}/${results.length} checks, ${results.filter((r) => r.soft).length} soft)`,
      '',
      '## Requirement coverage',
      '',
      '| G8 req | evidence |',
      '|---|---|',
      '| 1. active never >2 (DB lease count 時間點 + metrics) | lease-sampler.json (150ms resource_lease series, max) + api activeCount peaks in table |',
      '| 2. all 5 identity 到終態 COMPLETED | Phase A identity rows (db-identities.tsv) |',
      '| 3. pause 中途：running 唔 kill、queued 停派 | Phase B rows (incl. zero attempt_started after pause ts) |',
      '| 4. kill -9 → reconciliation 收復、唔雙跑 | Phase C/D rows (EXECUTOR_LOST, retry attempt) + attempt-events.tsv |',
      '| 5. 雙 scheduler 同時 tick 唔重複 enqueue | Phase A idempotency rows (5 rows/5 events/2 schedulers) |',
      '',
      '## Checks',
      '',
      '| phase | check | result | detail |',
      '|---|---|---|---|',
      ...results.map((r) => `| ${r.phase} | ${r.name} | ${r.pass ? 'PASS' : 'FAIL'}${r.soft ? ' (soft)' : ''} | ${r.detail.replace(/\|/g, '\\|')} |`),
      '',
    ].join('\n');
    writeFileSync(`${EVIDENCE}/report.md`, md);
    writeFileSync(`${RUN}/report.md`, md);
    return md;
  } catch (e) {
    console.error('EVIDENCE WRITE FAILED:', e.message);
    return null;
  }
}

// =============================================================================
const main = async () => {
  const ready = await waitFor('api ready', async () => {
    const r = await fetch(`${API}/api/health/ready`).catch(() => null);
    return r?.status === 200 ? r : null;
  }, { timeoutMs: 30_000 });
  if (!ready) throw new Error('API never became ready');
  console.log('[setup] API ready');
  await login();
  console.log('[setup] logged in');

  // W1 + W2: BOTH scheduler replicas (G8 req 5: two schedulers tick the same
  // batch simultaneously — idempotency must hold live, not just in unit tests).
  startWorker('1', { healthPort: 16324, scheduler: true });
  startWorker('2', { healthPort: 16325, scheduler: true });
  await sleep(3_000); // queue connect + boot reconcile pass
  startLeaseSampler(150);
  console.log('[setup] W1(sched)+W2(sched) up, lease sampler on');

  // ------------------------------------------------------------------ PHASE A
  {
    const { batchId } = await createAndStartCycle('A', 'A', 5, 2);
    const res = await waitCycleTerminal('A', batchId, 120_000);
    const runs = res.d.runs;
    record('A', 'cycle reaches terminal without timeout', !res.timedOut, `elapsed=${Math.round(res.elapsedMs / 1000)}s`);
    record('A', 'batch COMPLETED', res.d.batch.status === 'COMPLETED', res.d.batch.status);
    record('A', 'all 5 runs succeeded', runs.length === 5 && runs.every((r) => r.status === 'succeeded'), runs.map((r) => r.status).join(','));
    record('A', 'api activeCount peak ≤ 2 (cap held — sampled metric)', res.peak <= 2, `peak=${res.peak}`);
    record('A', 'parallelism observed (peak reached 2)', res.peak >= 2, `peak=${res.peak}`);
    const idents = await api('GET', '/api/identities?pageSize=50');
    const aStatuses = seed.groups.A.map((id) => idents.json.items.find((i) => i.id === id)?.status);
    record('A', 'identities synced COMPLETED (G8 req 2)', aStatuses.every((s) => s === 'COMPLETED'), aStatuses.join(','));

    // --- G8 req 5: dual-scheduler idempotency (DB ground truth) ---
    const dbRuns = await db.taskRun.findMany({ where: { batchId } });
    record('A', 'idempotency: exactly 5 run rows for 5 identities (0 duplicates from 2 schedulers)', dbRuns.length === 5, `rows=${dbRuns.length}`);
    record('A', 'idempotency: no spurious retries (all attempt=1)', dbRuns.every((r) => r.attempt === 1), dbRuns.map((r) => r.attempt).join(','));
    const aEvents = await db.taskRunEvent.findMany({ where: { eventType: 'attempt_started', taskRunId: { in: dbRuns.map((r) => r.id) } } });
    const perRun = new Map(dbRuns.map((r) => [r.id, 0]));
    for (const e of aEvents) perRun.set(e.taskRunId, (perRun.get(e.taskRunId) ?? 0) + 1);
    record('A', 'idempotency: exactly one attempt_started per run (claim CAS live)', aEvents.length === 5 && [...perRun.values()].every((c) => c === 1), `events=${aEvents.length} perRun=${[...perRun.values()].join(',')}`);
    const w1log = workerLog('1');
    const w2log = workerLog('2');
    record('A', 'both replicas booted the batch scheduler', w1log.includes('batch scheduler started') && w2log.includes('batch scheduler started'), `w1=${w1log.includes('batch scheduler started')} w2=${w2log.includes('batch scheduler started')}`);
    record('A', 'both replicas consumed jobs (2 live executors)', w1log.includes('job completed') && w2log.includes('job completed'), `w1jobs=${(w1log.match(/job completed/g) ?? []).length} w2jobs=${(w2log.match(/job completed/g) ?? []).length}`);
    record('A', 'P2002 create-race observed (informational — proof the race path fired)', (w1log + w2log).includes('run create raced (P2002)'), 'races=0 is also fine (no race window hit)', { soft: true });
  }

  // ------------------------------------------------------------------ PHASE B
  {
    const { batchId } = await createAndStartCycle('B', 'B', 5, 2);
    const snap = await waitFor('B running', async () => {
      const d = await batchDetail(batchId);
      return (d.activeCount ?? 0) >= 1 ? d : null;
    }, { timeoutMs: 30_000 });
    if (!snap) throw new Error('B never got a running run');
    const runningAtPause = snap.runs.filter((r) => r.status === 'running').map((r) => r.id);
    const queuedAtPause = snap.runs.filter((r) => r.status === 'queued').map((r) => r.id);
    const pauseTs = Date.now();
    const pause = await api('POST', `/api/batches/${batchId}/pause`, { body: { stopExisting: false } });
    record('B', 'pause(stopExisting=false) accepted (202)', pause.status === 202, `${pause.status} ${pause.text.slice(0, 120)}`);
    const pausedState = await waitFor('B paused', async () => {
      const d = await batchDetail(batchId);
      return d.batch.status === 'PAUSED' ? d : null;
    }, { timeoutMs: 15_000 });
    record('B', 'batch → PAUSED', !!pausedState, pausedState?.batch.status ?? 'never');
    const settled = await waitFor('B runs settled', async () => {
      const d = await batchDetail(batchId);
      return d.runs.length > 0 && d.runs.every((r) => TERMINAL_RUN.includes(r.status)) ? d : null;
    }, { timeoutMs: 30_000 });
    const byId = new Map((settled?.runs ?? []).map((r) => [r.id, r.status]));
    record('B', 'running at pause NOT killed (all finished succeeded)', runningAtPause.every((id) => byId.get(id) === 'succeeded'), `runningAtPause=${runningAtPause.length} → ${runningAtPause.map((id) => byId.get(id)).join(',')}`);
    record('B', 'queued at pause stopped (settled cancelled/succeeded, none running)', queuedAtPause.every((id) => ['cancelled', 'succeeded'].includes(byId.get(id))), `queuedAtPause=${queuedAtPause.length} → ${queuedAtPause.map((id) => byId.get(id)).join(',')}`);
    const postPauseStarts = await db.taskRunEvent.count({
      where: { taskRunId: { in: [...runningAtPause, ...queuedAtPause] }, eventType: 'attempt_started', createdAt: { gt: new Date(pauseTs - 2000) } },
    });
    record('B', 'queued 停派: zero attempt_started after pause (hard dispatch-stop proof)', postPauseStarts === 0, `post-pause events=${postPauseStarts} (pause ts ${new Date(pauseTs).toISOString()})`);
    const resume = await api('POST', `/api/batches/${batchId}/resume`);
    record('B', 'resume accepted (202)', resume.status === 202, `${resume.status} ${resume.text.slice(0, 120)}`);
    const end = await waitCycleTerminal('B', batchId, 120_000);
    const succ = end.d.runs.filter((r) => r.status === 'succeeded');
    const cancelled = end.d.runs.filter((r) => r.status === 'cancelled');
    record('B', 'resume re-arms + completes: batch COMPLETED, every identity succeeded exactly once', !end.timedOut && end.d.batch.status === 'COMPLETED' && succ.length === 5, `status=${end.d.batch.status} runs=${end.d.runs.length} succeeded=${succ.length} cancelled=${cancelled.length}`);
    const idents = await api('GET', '/api/identities?pageSize=50');
    const bStatuses = seed.groups.B.map((id) => idents.json.items.find((i) => i.id === id)?.status);
    record('B', 'identities synced COMPLETED after resume', bStatuses.every((s) => s === 'COMPLETED'), bStatuses.join(','));
  }

  // ------------------------------------------------------------------ PHASE C
  {
    // Steady state: BOTH slots busy ⇒ (concurrency=1 per worker) the two
    // running runs sit on two different workers; killing W2 deterministically
    // orphans W2's run.
    const { batchId } = await createAndStartCycle('C', 'C', 5, 2);
    const snap = await waitFor('C steady (2 running)', async () => {
      const d = await batchDetail(batchId);
      return (d.activeCount ?? 0) >= 2 ? d : null;
    }, { timeoutMs: 30_000 });
    if (!snap) throw new Error('C never reached 2 concurrent runs');
    const runningAtKill = snap.runs.filter((r) => r.status === 'running').map((r) => r.id);
    const killTs = Date.now();
    const killed = kill9('2');
    console.log(`[C] kill -9 W2 @ ${new Date(killTs).toISOString()} (running at kill: ${runningAtKill.length})`);
    record('C', 'kill -9 on executor W2 executed', killed);
    const res = await waitCycleTerminal('C', batchId, 150_000);
    record('C', 'cycle converges after kill (surviving scheduler reconciles)', !res.timedOut && TERMINAL_BATCH.includes(res.d.batch.status), `status=${res.d.batch.status} elapsed=${Math.round(res.elapsedMs / 1000)}s`);
    record('C', 'batch COMPLETED (orphan re-tried to success)', res.d.batch.status === 'COMPLETED', res.d.batch.status);
    record('C', 'all runs terminal', res.d.runs.every((r) => TERMINAL_RUN.includes(r.status)), res.d.runs.map((r) => `${r.status}@a${r.attempt}`).join(','));
    const cRuns = await db.taskRun.findMany({ where: { batchId } });
    const cEvs = await db.taskRunEvent.findMany({ where: { taskRunId: { in: cRuns.map((r) => r.id) } } });
    const lostOnKilled = cEvs.filter((e) => e.taskRunId && runningAtKill.includes(e.taskRunId) && e.eventType === 'failed' && JSON.stringify(e.payloadJson ?? '').includes('EXECUTOR_LOST'));
    const lostElsewhere = cEvs.filter((e) => e.eventType === 'failed' && JSON.stringify(e.payloadJson ?? '').includes('EXECUTOR_LOST')).length;
    record('C', 'exactly one EXECUTOR_LOST, on a run that was running at kill (lease-expiry path, no blind re-run)', lostOnKilled.length === 1 && lostElsewhere === 1, `onKilledRuns=${lostOnKilled.length} totalLostEvents=${lostElsewhere}`);
    const orphanRun = cRuns.find((r) => r.attempt >= 2);
    record('C', 'orphan re-executed as attempt 2 and succeeded', orphanRun?.status === 'succeeded' && orphanRun.attempt === 2, orphanRun ? `attempt=${orphanRun.attempt} status=${orphanRun.status}` : 'no retried run');
    const leases = await slotLeaseCount();
    record('C', 'zero live container_slot leases', leases === 0, `leases=${leases}`);
  }

  // ------------------------------------------------------------------ PHASE D
  {
    // Deterministic orphan: only ONE prior worker survives C; stop it, run solo
    // on W3 (batchSize 1 ⇒ 3 sequential batches — progressCycles auto-progression
    // exercised live), kill -9 W3 mid-run, boot W4 to reconcile.
    const survivors = ['1', '2'].filter((n) => workers.get(n)?.proc.exitCode === null);
    record('D', 'exactly one prior worker alive (other was kill -9 in C)', survivors.length === 1, `alive=${survivors.join(',') || 'none'}`);
    await stopWorker(survivors[0]);
    const drained = await waitFor('D drain', async () => ((await liveRuns()) === 0 ? true : null), { timeoutMs: 25_000 });
    record('D', 'survivor drained cleanly (SIGTERM, no leftover runs)', !!drained, `liveRuns=${await liveRuns()}`);
    startWorker('3', { healthPort: 16326, scheduler: true });
    await sleep(2_500);
    const { batchId, cycle } = await createAndStartCycle('D', 'D', 1, 1);
    const batchIds = cycle.batches.map((b) => b.id);
    const snap = await waitFor('D running', async () => {
      const d = await batchDetail(batchId);
      return (d.activeCount ?? 0) >= 1 ? d : null;
    }, { timeoutMs: 30_000 });
    if (!snap) throw new Error('D never got a running run');
    const killed = kill9('3');
    console.log('[D] kill -9 W3 (SOLO worker) — lease now orphaned, no other executor alive');
    record('D', 'solo worker actually killed mid-run', killed);
    await sleep(1_500);
    startWorker('4', { healthPort: 16327, scheduler: true });
    const res = await waitAllCycleBatches('D', batchIds, 180_000);
    const statuses = res.all.map((d) => d.batch.status).join(',');
    record('D', 'full 3-batch cycle reaches terminal after reconcile', !res.timedOut, `statuses=[${statuses}] elapsed=${Math.round(res.elapsedMs / 1000)}s`);
    record('D', 'all 3 batches COMPLETED', res.all.every((d) => d.batch.status === 'COMPLETED'), statuses);
    const dRuns = await db.taskRun.findMany({ where: { batchId: batchIds } , orderBy: { createdAt: 'asc' } });
    const orphanRun = dRuns.find((r) => r.batchId === batchId);
    record('D', 'orphan run re-executed: attempt=2 succeeded (EXECUTOR_LOST → retry → success)', orphanRun?.status === 'succeeded' && orphanRun?.attempt === 2, orphanRun ? `attempt=${orphanRun.attempt} status=${orphanRun.status}` : 'missing');
    const dEvs = await db.taskRunEvent.findMany({ where: { taskRunId: { in: dRuns.map((r) => r.id) } } });
    const lost = dEvs.filter((e) => e.eventType === 'failed' && JSON.stringify(e.payloadJson ?? '').includes('EXECUTOR_LOST'));
    record('D', 'exactly one EXECUTOR_LOST reconciliation event (deterministic orphan)', lost.length === 1, `lostEvents=${lost.length}`);
    const leases = await slotLeaseCount();
    record('D', 'zero live container_slot leases after reconcile', leases === 0, `leases=${leases}`);
    const idents = await api('GET', '/api/identities?pageSize=50');
    const dStatuses = seed.groups.D.map((id) => idents.json.items.find((i) => i.id === id)?.status);
    record('D', 'all D identities honestly terminal (COMPLETED)', dStatuses.every((s) => s === 'COMPLETED'), dStatuses.join(','));
    const dBatchRows = await db.batch.findMany({ where: { id: { in: batchIds } }, orderBy: { batchNo: 'asc' } });
    const auto1 = dBatchRows[1]?.startedAt && dBatchRows[0]?.finishedAt ? dBatchRows[1].startedAt > dBatchRows[0].finishedAt : false;
    const auto2 = dBatchRows[2]?.startedAt && dBatchRows[1]?.finishedAt ? dBatchRows[2].startedAt > dBatchRows[1].finishedAt : false;
    record('D', 'progressCycles live: batch #2/#3 auto-started by scheduler (startedAt > prev finishedAt, no API start call)', auto1 && auto2, `b1→b2=${auto1} b2→b3=${auto2}`);
  }

  // ------------------------------------------------------------------ GLOBAL
  const samplerMax = stopLeaseSampler();
  record('G', 'DB lease sampler: max concurrent container_slot leases ≤ 2 (whole run, 150ms points)', samplerMax <= 2, `max=${samplerMax} samples=${leaseSamples.length}`);
  const uniq = await attemptStartedUniqueness();
  record('G', 'no double execution: exactly one attempt_started per (run, attempt) across ALL phases', uniq.dups.length === 0, `events=${uniq.total} groups=${uniq.groups} dups=${uniq.dups.length}`);
  const finalLeases = await slotLeaseCount();
  record('G', 'final state: zero live container_slot leases', finalLeases === 0, `leases=${finalLeases}`);

  // ------------------------------------------------------------------ report
  const md = await writeEvidence({ phaseNote: 'smoke complete' });
  const hardFails = results.filter((r) => !r.pass && !r.soft);
  console.log(`\n[report] ${EVIDENCE}/report.md — ${hardFails.length === 0 ? 'ALL HARD CHECKS PASSED' : `HARD FAILURES: ${hardFails.map((h) => `${h.phase}:${h.name}`).join('; ')}`}`);
  return { ok: hardFails.length === 0, md };
};

main()
  .then(async ({ ok }) => {
    await db.$disconnect().catch(() => {});
    process.exit(ok ? 0 : 1);
  })
  .catch(async (e) => {
    console.error('SMOKE DRIVER ERROR:', e);
    try { await writeEvidence({ phaseNote: `driver crashed: ${e.message}` }); } catch { /* best effort */ }
    await db.$disconnect().catch(() => {});
    process.exit(2);
  })
  .finally(() => {
    for (const name of ['1', '2', '3', '4']) stopWorker(name).catch(() => {});
  });
