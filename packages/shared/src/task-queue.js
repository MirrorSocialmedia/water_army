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
  await queue.add(TASK_JOB_NAME, { runId, attempt }, { jobId: taskJobId(runId, attempt), timeout });
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

/** @param {Queue} queue */
export async function closeTaskQueue(queue) {
  try {
    await queue?.close();
  } catch {
    /* best effort */
  }
}
