/**
 * Task queue (API side) — the API is a producer of task-run jobs.
 *
 * P4: the implementation moved to @water-army/shared (task-queue.js) so the
 * WORKER can produce task-run jobs too (schedule fire → createRun → enqueue).
 * This file is a thin re-export — P3 callers and tests keep working verbatim.
 *
 * Iron rules (P1 教訓):
 *  - connection is ALWAYS the { url } form via buildRedisConnection()
 *  - the underlying ioredis gets an 'error' listener (without one, the first
 *    connect failure is an unhandled EventEmitter 'error' → process crash)
 */
export { createTaskQueue, enqueueTaskRun, removeWaitingTaskRun, closeTaskQueue } from '@water-army/shared';
