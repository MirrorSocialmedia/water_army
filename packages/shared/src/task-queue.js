/**
 * Task queue — shared producer utilities (canonical home, P4).
 *
 * Moved here (byte-for-byte) from apps/api/src/plugins/task-queue.js in P4 so
 * the WORKER can produce task-run jobs too (schedule fire → createRun →
 * enqueue). The API plugin now re-exports from here — P3 behavior unchanged.
 *
 * Iron rules (P1 教訓):
 *  - connection is ALWAYS the { url } form via buildRedisConnection()
 *  - the underlying ioredis gets an 'error' listener (without one, the first
 *    connect failure is an unhandled EventEmitter 'error' → process crash)
 *
 * Jobs are secret-free ({ runId, attempt }); the deterministic job id
 * `${runId}-${attempt}` (taskJobId) makes enqueue idempotent (retries never
 * double-up). BullMQ keeps only transport history (age-bounded); PostgreSQL
 * is the source of truth (MD §11.2 — queue 死咗都睇得到歷史).
 */
import { Queue } from 'bullmq';
import { TASK_QUEUE_NAME, TASK_JOB_NAME, taskJobId } from './task-constants.js';
import { BATCH_RUN_JOB_NAME, batchJobId } from './batch-constants.js';
import { buildRedisConnection } from './redis-connection.js';

/**
 * @param {{redisUrl:string}} config
 * @param {object} [log] pino logger
 */
export function createTaskQueue(config, log = console) {
  const queue = new Queue(TASK_QUEUE_NAME, {
    connection: buildRedisConnection(config.redisUrl),
    defaultJobOptions: {
      // No BullMQ-level auto-retry: an unexpected processor crash leaves the
      // run in a state the user can inspect + retry explicitly (new attempt).
      attempts: 1,
      // Transport history is bounded — the DB holds the real history.
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 7 * 86_400 },
    },
  });
  if (queue.client) {
    queue.client.on('error', (err) => {
      log?.warn?.({ error: err.message }, 'task queue redis error (BullMQ will reconnect)');
    });
  }
  return queue;
}

/**
 * Enqueue one run attempt (idempotent on job id).
 * @param {Queue} queue
 * @param {{runId:string, attempt:number, timeoutMs?:number}} run
 */
export async function enqueueTaskRun(queue, { runId, attempt, timeoutMs }) {
  // BullMQ job timeout = run deadline + grace, so a wedged job is reaped
  // even if the engine's own deadline logic is bypassed (backstop only).
  const timeout = (Number.isFinite(timeoutMs) ? timeoutMs : 120_000) + 30_000;
  // BR-B6 (E2E run-4): lockDuration must outlive the LONGEST legitimate
  // processor time — the job's own timeout backstop. The BullMQ default
  // 30s lock expired mid-job for any run longer than 30s: the stalled
  // check requeued the live job (duplicate processing) and the original
  // completion then failed with 'not in active state / Missing lock' — a
  // 468k-line error storm in run-4 while runs themselves stayed correct
  // (the engine's CAS guards made the duplicate a no-op).
  return queue.add(TASK_JOB_NAME, { runId, attempt }, { jobId: taskJobId(runId, attempt), timeout, lockDuration: timeout });
}

/**
 * Best-effort removal of a WAITING job (cancel path). No-op if the job is
 * already active/removed — the engine's DB cancel poll is the real stop.
 * @returns {Promise<boolean>} true if a waiting job was removed
 */
export async function removeWaitingTaskRun(queue, runId, attempt) {
  try {
    const job = await queue.getJob(taskJobId(runId, attempt));
    if (!job) return false;
    await job.remove(); // BullMQ rejects when the job can't be removed; treat as no-op
    return true;
  } catch {
    return false;
  }
}

/**
 * Enqueue one batch run attempt (idempotent on job id, BR-B2 MD §7).
 *
 * Idempotency is enforced TWICE (belt and braces, both live-verified shapes):
 *  - a getJob(jobId) pre-check returns the existing job instead of adding;
 *  - BullMQ (real AND the hermetic fake) throws on a custom job id collision,
 *    which is caught and treated as a reuse — a redelivered start can never
 *    double-dispatch the same run+attempt.
 *
 * The job timeout is a BACKSTOP only: worst-case total attempt time + backoff
 * + margin. A wedged job is reaped by BullMQ; the run row stays RUNNING with
 * a dead lease, and the lease reconciliation (MD §6.2) makes it honest —
 * never silently re-run.
 *
 * @param {Queue} queue the BullMQ queue (ai-tasks)
 * @param {{runId:string, attempt:number, timeoutMs?:number, maxAttempts?:number}} run
 * @returns {Promise<{queued:boolean, reused:boolean, jobId:string}>}
 */
export async function enqueueBatchRun(queue, { runId, attempt, timeoutMs, maxAttempts, delayMs = 0 }) {
  const jobId = batchJobId(runId, attempt);
  const existing = await queue.getJob(jobId);
  if (existing) return { queued: false, reused: true, jobId };
  const attemptTimeout = Number.isFinite(timeoutMs) ? timeoutMs : 900_000;
  const attempts = Math.max(1, Number.isFinite(maxAttempts) ? maxAttempts : 3);
  const timeout = attemptTimeout * attempts + 30_000 * attempts + 300_000;
  // B6 gen3 (E2E run-3 wave: 6/6 FAILED_FINAL during a ~5s API restart):
  // auto-retries are delivered with a delay so the maxAttempts budget SPANS
  // a transient dependency outage instead of burning 3 attempts inside it.
  const delay = Math.max(0, Math.floor(Number(delayMs) || 0));
  // lockDuration = the job's own timeout backstop: the longest legitimate
  // processor time. See enqueueTaskRun (E2E run-4 lock-expiry storm).
  try {
    await queue.add(BATCH_RUN_JOB_NAME, { runId, attempt }, { jobId, attempts: 1, timeout, lockDuration: timeout, ...(delay > 0 ? { delay } : {}) });
    return { queued: true, reused: false, jobId };
  } catch (err) {
    if (err?.name === 'JobExistsError' || /already exists/i.test(String(err?.message ?? ''))) {
      return { queued: false, reused: true, jobId };
    }
    throw err;
  }
}

/**
 * Best-effort removal of a WAITING batch-run job (cancel/pause path).
 * No-op if the job is already active/removed — the engine's DB cancel poll
 * is the real stop (same contract as removeWaitingTaskRun).
 * @returns {Promise<boolean>} true if a waiting job was removed
 */
export async function removeWaitingBatchRun(queue, runId, attempt) {
  try {
    const job = await queue.getJob(batchJobId(runId, attempt));
    if (!job) return false;
    await job.remove();
    return true;
  } catch {
    return false;
  }
}

/**
 * Batch-aware enqueue router (BR-B2): a run with a batchId goes to the
 * batch-run job; everything else keeps the existing task-run path byte-for-
 * byte. Both the API producer and the worker producer (schedule fire, manual
 * retry) MUST route through here — a plain enqueueTaskRun on a batch run
 * would dispatch it to the provider engine (wrong execution path).
 *
 * @param {Queue} queue
 * @param {{db:object, runId:string, attempt:number, timeoutMs?:number, maxAttempts?:number, run?:object}} p
 *   `run` may be passed when the caller already read the row (avoids a second
 *   PK read); otherwise it is read from db.
 */
export async function enqueueAnyRun(queue, { db, runId, attempt, timeoutMs, maxAttempts, run, delayMs = 0 }) {
  const row = run ?? (db ? await db.taskRun.findUnique({ where: { id: runId } }) : null);
  if (row?.batchId) {
    return enqueueBatchRun(queue, { runId, attempt, timeoutMs, maxAttempts: row?.maxAttempts ?? maxAttempts, delayMs });
  }
  // queue.add resolves to a Job (BullMQ) / { id } (fake) — normalize to id.
  const job = await enqueueTaskRun(queue, { runId, attempt, timeoutMs });
  return { queued: true, reused: false, jobId: job?.id ?? job };
}

/** @param {Queue} queue */
export async function closeTaskQueue(queue) {
  try {
    await queue?.close();
  } catch {
    /* best effort */
  }
}
