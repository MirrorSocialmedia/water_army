/**
 * TaskRunService — the SINGLE owner of task-run state (施工 MD §11.3).
 *
 *  "所有合法狀態轉換集中在 TaskRunService，不能由任意 route 直接更新"
 *
 * Both the API (create/cancel/retry/approve) and the worker (attempt
 * lifecycle, tool flow, finish) go through this service. Zero npm
 * dependencies: db / enqueue are injected (Prisma-shaped / fake-shaped),
 * so unit + integration tests run hermetically.
 *
 * Persistence (MD §11.2 / 工單): DB = source of truth. Every status
 * transition and every attempt outcome is an `task_run_events` row —
 * history survives queue/worker death; the queue only carries
 * `{runId, attempt}` (no secrets, no prompt — MD §11.2.4).
 */
import {
  TASK_RUN_STATUS,
  TASK_RUN_TERMINAL,
  TASK_RUN_TRANSITIONS,
  TASK_EVENT,
  TASK_DEFAULTS,
  PROVIDER_ERROR,
} from './task-constants.js';
import { scrubObject } from './scrub.js';
import { safeStringify } from './tool-registry.js';

/**
 * Stable, route-passable error (carries apiCode for the error envelope).
 */
export class TaskRunError extends Error {
  /**
   * @param {string} code e.g. 'ILLEGAL_STATE_TRANSITION', 'RUN_NOT_FOUND'
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status] HTTP status for the API layer
   */
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'TaskRunError';
    this.apiCode = code;
    this.statusCode = status;
  }
}

/**
 * Exponential backoff for auto-retry (MD §12.3: 指數退避 + 上限).
 * @param {number} attempt 1-based attempt number about to sleep before
 * @param {object} [opts]
 * @param {number} [opts.baseMs]
 * @param {number} [opts.factor]
 * @param {number} [opts.maxMs]
 * @param {number} [opts.jitter] 0..1 fraction of randomness
 * @param {() => number} [rand] injectable for deterministic tests
 */
export function backoffDelay(attempt, opts = {}, rand = Math.random) {
  const baseMs = opts.baseMs ?? TASK_DEFAULTS.RETRY_BASE_MS;
  const factor = opts.factor ?? TASK_DEFAULTS.RETRY_FACTOR;
  const maxMs = opts.maxMs ?? TASK_DEFAULTS.RETRY_MAX_MS;
  const jitter = opts.jitter ?? 0;
  const n = Math.max(0, Number(attempt) - 1);
  const raw = baseMs * Math.pow(factor, n);
  const capped = Math.min(raw, maxMs);
  if (!jitter) return capped;
  const lo = capped * (1 - jitter);
  return Math.floor(lo + rand() * capped * jitter);
}

/**
 * @param {object} deps
 * @param {object} deps.db      Prisma client (or fake) — needs taskRun/taskRunEvent/approvalRequest
 * @param {object} [deps.config] API config shape (taskDefaultTimeoutMs, taskMaxTimeoutMs, taskDefaultAttempts)
 * @param {(jobData:{runId:string,attempt:number}) => Promise<unknown>} [deps.enqueue] queue seam (API side)
 * @param {object} [deps.log]
 */
export function createTaskRunService({ db, config = {}, enqueue, log = console }) {
  const defaultTimeoutMs = config.taskDefaultTimeoutMs ?? 120_000;
  const maxTimeoutMs = config.taskMaxTimeoutMs ?? 900_000;
  const defaultAttempts = config.taskDefaultAttempts ?? 3;

  // ------------------------------------------------------------------ guards
  /** @returns {boolean} */
  function canTransition(from, to) {
    return (TASK_RUN_TRANSITIONS[from] ?? []).includes(to);
  }

  function assertTransition(from, to, runId) {
    if (!canTransition(from, to)) {
      throw new TaskRunError(
        'ILLEGAL_STATE_TRANSITION',
        `Illegal task-run transition: ${from} → ${to} (run ${runId})`,
        { status: 409 },
      );
    }
  }

  async function loadRun(runId, { mustExist = true } = {}) {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new TaskRunError('RUN_NOT_FOUND', 'Invalid run id', { status: 404 });
    }
    const run = await db.taskRun.findUnique({ where: { id: runId } });
    if (!run && mustExist) {
      throw new TaskRunError('RUN_NOT_FOUND', `Task run ${runId} not found`, { status: 404 });
    }
    return run;
  }

  // ------------------------------------------------------------------ events
  /**
   * Append a run event. Payload is scrubbed (MD §13.3) and size-bounded.
   * @returns {Promise<object>} the stored row
   */
  async function recordEvent(runId, eventType, { message, payload, attempt } = {}) {
    const clean = { ...(payload ?? {}) };
    if (attempt !== undefined) clean.attempt = attempt;
    return db.taskRunEvent.create({
      data: {
        taskRunId: runId,
        eventType,
        message: message ? String(message).slice(0, 500) : null,
        payloadJson: scrubObject(clean, TASK_DEFAULTS.EVENT_PREVIEW_CHARS),
      },
    });
  }

  /** Generic transition (internal): asserts, updates, records `status` event. */
  async function transition(run, to, { event = TASK_EVENT.STATUS, message, payload } = {}) {
    assertTransition(run.status, to, run.id);
    const updated = await db.taskRun.update({
      where: { id: run.id },
      data: { status: to },
    });
    await recordEvent(run.id, event, {
      message,
      payload: { from: run.status, to, ...(payload ?? {}) },
    });
    return updated;
  }

  async function listPendingApprovals(runId) {
    return db.approvalRequest.findMany({ where: { taskRunId: runId, status: 'pending' } });
  }

  /** Expire pending approvals when a run ends without them being resolved. */
  async function expirePendingApprovals(runId) {
    const pending = await listPendingApprovals(runId);
    for (const a of pending) {
      await db.approvalRequest.update({
        where: { id: a.id },
        data: { status: 'expired' },
      });
      await recordEvent(runId, TASK_EVENT.APPROVAL_RESOLVED, {
        message: 'approval expired (run ended)',
        payload: { approvalId: a.id, decision: 'expired', tool: a.toolName },
      });
    }
  }

  // ------------------------------------------------------------------ create
  /**
   * Validate + persist a new run, emit `queued`, enqueue (runId+attempt only).
   * Idempotent on `idempotencyKey` (MD §12.3: 防 API 重複提交).
   *
   * @param {object} input
   * @param {string} input.prompt
   * @param {string} [input.provider] provider name ('mock' or a provider_configs.name)
   * @param {'analysis_only'|'approved_tools'} [input.mode]
   * @param {number} [input.timeoutMs]
   * @param {number} [input.maxAttempts]
   * @param {string[]} [input.tools] tool allowlist subset (MD §11.4)
   * @param {string} [input.idempotencyKey]
   * @param {string} [input.title]
   * @param {string} [input.scheduleId] P4: originating schedule (uuid) — set on
   *   scheduled + run-now fires; null for ad-hoc runs.
   * @param {string} [input.taskDefinitionId] P4: originating definition (uuid)
   * @param {object} user {id, username}
   * @returns {Promise<{run:object, replay:boolean}>}
   */
  async function createRun(input, user) {
    const errors = validateCreateInput(input);
    if (errors.length) {
      throw new TaskRunError('VALIDATION_ERROR', `Invalid task run: ${errors.join('; ')}`, { status: 400 });
    }

    const prompt = input.prompt.trim();
    const mode = input.mode ?? 'analysis_only';
    const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
    const maxAttempts = input.maxAttempts ?? defaultAttempts;
    const provider = input.provider;

    // Idempotency first (replay returns the ORIGINAL run, no new job).
    if (input.idempotencyKey) {
      const existing = await db.taskRun.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { run: existing, replay: true };
    }

    const inputJson = {
      prompt,
      provider: provider ?? null,
      mode,
      timeoutMs,
      maxAttempts,
      tools: input.tools ?? null,
      title: input.title ?? null,
      // P4: the SCHEDULED slot time for schedule-fired runs (auto + run-now).
      // UI/API delay = run.createdAt − scheduledSlotAt (MD §1.4 盡力非硬性).
      scheduledSlotAt: typeof input.scheduledSlotAt === 'string' ? input.scheduledSlotAt : null,
    };

    let run;
    try {
      run = await db.taskRun.create({
        data: {
          status: 'queued',
          inputJson,
          attempt: 1,
          queuedAt: new Date(),
          requestedBy: user?.id ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          // P4: schedule lineage (both nullable — ad-hoc runs leave them null).
          scheduleId: input.scheduleId ?? null,
          taskDefinitionId: input.taskDefinitionId ?? null,
        },
      });
    } catch (err) {
      // P2002 = unique violation (idempotencyKey raced) → replay original.
      if (String(err?.code ?? '').includes('P2002') && input.idempotencyKey) {
        const existing = await db.taskRun.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return { run: existing, replay: true };
      }
      throw err;
    }

    await recordEvent(run.id, TASK_EVENT.QUEUED, {
      message: 'run created and queued',
      payload: { provider: provider ?? null, mode, timeoutMs, maxAttempts, requestedBy: user?.username ?? null },
    });

    if (typeof enqueue === 'function') {
      try {
        await enqueue({ runId: run.id, attempt: 1 });
      } catch (err) {
        // Honest failure: the run must NOT sit in `queued` forever pretending.
        await safeSetStatus(run, 'failed', {
          errorCode: 'ENQUEUE_FAILED',
          errorMessage: `Failed to enqueue: ${err.message}`.slice(0, 500),
          finishedAt: new Date(),
          durationMs: 0,
        });
        await recordEvent(run.id, TASK_EVENT.FAILED, {
          message: 'enqueue failed',
          payload: { errorCode: 'ENQUEUE_FAILED', attempt: 1 },
        });
        log.error?.({ runId: run.id, error: err.message }, 'run enqueue failed');
        throw new TaskRunError('ENQUEUE_FAILED', 'Could not queue the task run (queue unavailable)', { status: 503 });
      }
    }
    return { run, replay: false };
  }

  function validateCreateInput(input) {
    const errors = [];
    if (typeof input?.prompt !== 'string' || input.prompt.trim().length === 0) {
      errors.push('prompt is required (non-empty string)');
    } else if (input.prompt.length > TASK_DEFAULTS.MAX_PROMPT_CHARS) {
      errors.push(`prompt too long (max ${TASK_DEFAULTS.MAX_PROMPT_CHARS} chars)`);
    }
    if (input.provider !== undefined && input.provider !== null) {
      if (typeof input.provider !== 'string' || input.provider.length === 0 || input.provider.length > 64) {
        errors.push('provider must be a name string (1..64 chars) or null');
      }
    }
    if (input.mode !== undefined && input.mode !== 'analysis_only' && input.mode !== 'approved_tools') {
      errors.push("mode must be 'analysis_only' or 'approved_tools'");
    }
    if (input.timeoutMs !== undefined) {
      if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000) {
        errors.push('timeoutMs must be an integer >= 1000');
      } else if (input.timeoutMs > maxTimeoutMs) {
        errors.push(`timeoutMs exceeds system cap ${maxTimeoutMs}ms (MD 附錄 A: 唔接受無上限執行)`);
      }
    }
    if (input.maxAttempts !== undefined) {
      if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
        errors.push('maxAttempts must be an integer >= 1');
      } else if (input.maxAttempts > TASK_DEFAULTS.MAX_ATTEMPTS_CAP) {
        errors.push(`maxAttempts exceeds system cap ${TASK_DEFAULTS.MAX_ATTEMPTS_CAP}`);
      }
    }
    if (input.tools !== undefined && input.tools !== null) {
      if (!Array.isArray(input.tools) || input.tools.some((t) => typeof t !== 'string')) {
        errors.push('tools must be an array of tool names');
      } else if (input.tools.length > 16) {
        errors.push('tools allowlist too large (max 16)');
      }
    }
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(input.idempotencyKey)) {
        errors.push('idempotencyKey must match ^[A-Za-z0-9_-]{8,64}$');
      }
    }
    for (const k of ['scheduleId', 'taskDefinitionId']) {
      if (input[k] !== undefined && input[k] !== null) {
        if (typeof input[k] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input[k])) {
          errors.push(`${k} must be a uuid`);
        }
      }
    }
    return errors;
  }

  // ------------------------------------------------------- P4: overlap skips
  /**
   * Record a SUPPRESSED schedule slot (overlap_policy = skip_if_running,
   * MD §12.3: 「skip_if_running 時需記錄一筆 skipped run 或 schedule event，
   * 並解釋被略過原因」).
   *
   * The run is created ALREADY terminal: `skipped` is a closed leaf in the
   * transition table (no in/out edges) and finishRun() explicitly refuses to
   * write it — a skipped run is never "finished", it is born skipped. No
   * enqueue, no worker work: the slot left a trail (run row + event) and
   * nothing else.
   *
   * Idempotent on `idempotencyKey` (per schedule+slot, scheduleSkipKey) — a
   * redelivered fire of the same slot skips exactly once.
   *
   * @param {object} input
   * @param {string} input.prompt  the prompt that WOULD have run (audit trail)
   * @param {string} input.scheduleId
   * @param {string} [input.taskDefinitionId]
   * @param {string} [input.idempotencyKey]
   * @param {string} [input.title]
   * @param {string} input.reason  why the slot was skipped (human-readable)
   * @param {string} [input.activeRunId] the run that caused the skip
   * @param {string} [input.scheduledSlotAt] ISO of the suppressed slot
   * @param {object} user {id, username}
   * @returns {Promise<{run:object, replay:boolean}>}
   */
  async function createSkippedRun(input, user) {
    const errors = [];
    if (typeof input?.prompt !== 'string' || input.prompt.trim().length === 0) {
      errors.push('prompt is required (non-empty string)');
    }
    if (typeof input?.scheduleId !== 'string' || input.scheduleId.length === 0) {
      errors.push('scheduleId is required for a skipped run');
    }
    if (typeof input?.reason !== 'string' || input.reason.trim().length === 0) {
      errors.push('reason is required (MD §12.3: 解釋被略過原因)');
    }
    if (typeof input?.idempotencyKey === 'string' && !/^[A-Za-z0-9_-]{8,64}$/.test(input.idempotencyKey)) {
      errors.push('idempotencyKey must match ^[A-Za-z0-9_-]{8,64}$');
    }
    if (errors.length) {
      throw new TaskRunError('VALIDATION_ERROR', `Invalid skipped run: ${errors.join('; ')}`, { status: 400 });
    }

    if (input.idempotencyKey) {
      const existing = await db.taskRun.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { run: existing, replay: true };
    }

    const now = new Date();
    const inputJson = {
      prompt: input.prompt,
      schedule: true,
      skipped: {
        reason: input.reason,
        activeRunId: input.activeRunId ?? null,
        scheduledSlotAt: input.scheduledSlotAt ?? null,
        policy: 'skip_if_running',
      },
      title: input.title ?? null,
    };

    let run;
    try {
      run = await db.taskRun.create({
        data: {
          // Born terminal — see the method doc. finishedAt is written at
          // birth (the only finishedAt write for this run's lifetime).
          status: 'skipped',
          inputJson,
          attempt: 1,
          queuedAt: now,
          finishedAt: now,
          durationMs: 0,
          requestedBy: user?.id ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          scheduleId: input.scheduleId,
          taskDefinitionId: input.taskDefinitionId ?? null,
        },
      });
    } catch (err) {
      if (String(err?.code ?? '').includes('P2002') && input.idempotencyKey) {
        const existing = await db.taskRun.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return { run: existing, replay: true };
      }
      throw err;
    }

    await recordEvent(run.id, TASK_EVENT.STATUS, {
      message: `slot skipped: ${input.reason}`.slice(0, 500),
      payload: {
        from: null,
        to: 'skipped',
        reason: input.reason,
        activeRunId: input.activeRunId ?? null,
        scheduledSlotAt: input.scheduledSlotAt ?? null,
      },
    });
    return { run, replay: false };
  }

  // ------------------------------------------------------------------ cancel
  /**
   * Idempotent cancel request (工單: 已 ended 嘅 cancel = no-op).
   * Sets `cancel_requested`; the WORKER performs the real stop (abort in-flight
   * provider call, stop the tool loop) and then writes terminal `cancelled`.
   */
  async function requestCancel(runId, { actorUserId = null, reason = null } = {}) {
    const run = await loadRun(runId);
    if (TASK_RUN_TERMINAL.includes(run.status)) {
      return { run, idempotent: true, requested: false };
    }
    if (run.status === 'cancel_requested') {
      // Already requested — the worker will (or is) performing the stop.
      return { run, idempotent: true, requested: false };
    }
    assertTransition(run.status, 'cancel_requested', run.id);
    const updated = await db.taskRun.update({ where: { id: run.id }, data: { status: 'cancel_requested' } });
    await recordEvent(run.id, TASK_EVENT.CANCEL_REQUESTED, {
      message: `cancel requested${actorUserId ? ` by ${actorUserId}` : ''}`,
      payload: { by: actorUserId ?? null, reason },
    });
    return { run: updated, idempotent: false, requested: true };
  }

  /**
   * Worker-confirmed stop (called by the engine/reconciler — the ONLY writer
   * of `cancelled`). Idempotent-safe: illegal from terminal states throws.
   */
  async function markCancelled(runId, { reason = null, attempt = null } = {}) {
    const run = await loadRun(runId);
    if (run.status === 'cancelled') return { run, idempotent: true };
    assertTransition(run.status, 'cancelled', run.id);
    const now = new Date();
    const updated = await db.taskRun.update({
      where: { id: run.id },
      data: { status: 'cancelled', finishedAt: now, durationMs: durationOf(run, now) },
    });
    await recordEvent(run.id, TASK_EVENT.CANCELLED, {
      message: 'run cancelled (execution stopped)',
      payload: { reason, attempt },
    });
    await expirePendingApprovals(run.id);
    return { run: updated, idempotent: false };
  }

  // ------------------------------------------------------------------ retry
  /**
   * Manual retry (MD §6.5: 重試必須係新 attempt，唔可偷偷覆蓋舊紀錄).
   * Allowed only from failed / timed_out / cancelled. Increments `attempt`,
   * clears the latest-attempt fields (the previous output stays preserved in
   * the event stream), re-queues with job id `${runId}-${attempt}` (taskJobId).
   */
  async function requestRetry(runId, { actorUserId = null, note = null } = {}) {
    const run = await loadRun(runId);
    const retryable = ['failed', 'timed_out', 'cancelled'].includes(run.status);
    if (!retryable) {
      throw new TaskRunError(
        'RETRY_NOT_ALLOWED',
        `Retry only allowed from failed/timed_out/cancelled (run is '${run.status}')`,
        { status: 409 },
      );
    }
    const nextAttempt = run.attempt + 1;
    if (nextAttempt > 999) {
      throw new TaskRunError('RETRY_LIMIT', 'Attempt limit reached for this run', { status: 409 });
    }

    const previous = {
      status: run.status,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage ? String(run.errorMessage).slice(0, 300) : null,
      outputChars: run.resultText ? String(run.resultText).length : 0,
    };

    const updated = await db.taskRun.update({
      where: { id: run.id },
      data: {
        status: 'queued',
        attempt: nextAttempt,
        queuedAt: new Date(),
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        resultText: null,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    await recordEvent(runId, TASK_EVENT.RETRY_REQUESTED, {
      message: `manual retry → attempt ${nextAttempt}`,
      payload: { by: actorUserId ?? null, note, previous },
    });

    if (typeof enqueue === 'function') {
      try {
        await enqueue({ runId: run.id, attempt: nextAttempt });
      } catch (err) {
        await db.taskRun.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            errorCode: 'ENQUEUE_FAILED',
            errorMessage: `Retry enqueue failed: ${err.message}`.slice(0, 500),
          },
        });
        throw new TaskRunError('ENQUEUE_FAILED', 'Could not re-queue the retry (queue unavailable)', { status: 503 });
      }
    }
    return { run: updated, attempt: nextAttempt };
  }

  // ------------------------------------------------------- auto-retry (engine)
  /**
   * Auto-retry bump (MD §11.8: transient provider error, attempt < maxAttempts).
   * Unlike requestRetry this does NOT re-queue — the engine keeps the job and
   * starts the next attempt in-process (the run stays 'running' throughout;
   * the user sees attempt N → auto_retry → attempt N+1 in the event stream).
   * Only legal from 'running' with run.attempt === expectedAttempt (stale guard).
   */
  async function bumpAttempt(runId, { expectedAttempt, code = null, delayMs = 0, reason = null } = {}) {
    const run = await loadRun(runId);
    if (run.status !== 'running') {
      throw new TaskRunError('BUMP_NOT_ALLOWED', `attempt bump only from running (run is '${run.status}')`, { status: 409 });
    }
    if (expectedAttempt != null && run.attempt !== expectedAttempt) {
      throw new TaskRunError('STALE_ATTEMPT', `run is at attempt ${run.attempt}, expected ${expectedAttempt}`, { status: 409 });
    }
    const nextAttempt = run.attempt + 1;
    if (nextAttempt > 999) {
      throw new TaskRunError('RETRY_LIMIT', 'Attempt limit reached for this run', { status: 409 });
    }
    const updated = await db.taskRun.update({
      where: { id: run.id },
      data: {
        attempt: nextAttempt,
        // previous attempt's partial output belongs to the event stream, not the row
        resultText: null,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    await recordEvent(runId, TASK_EVENT.RETRY, {
      message: `auto retry (transient ${code ?? 'error'}) → attempt ${nextAttempt}`,
      payload: { code, delayMs, reason: reason ?? null, fromAttempt: run.attempt, toAttempt: nextAttempt },
    });
    return { run: updated, attempt: nextAttempt };
  }

  // ---------------------------------------------------------------- approvals
  /**
   * Record a pending approval (worker side, when a tool call needs a human).
   */
  async function createApproval({ runId, toolName, arguments: args, preview }) {
    const row = await db.approvalRequest.create({
      data: {
        taskRunId: runId,
        toolName,
        argumentsJson: scrubObject(args ?? null, TASK_DEFAULTS.EVENT_PREVIEW_CHARS),
      },
    });
    await recordEvent(runId, TASK_EVENT.WAITING_APPROVAL, {
      message: `waiting for human approval: ${toolName}`,
      payload: { approvalId: row.id, tool: toolName, preview: preview ?? null },
    });
    return row;
  }

  /**
   * Human decision (API side, admin-only at the route). AI can never reach
   * this path: it has no session; the service token is operator-level.
   */
  async function resolveApproval(approvalId, { decision, actorUserId, note = null }) {
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new TaskRunError('VALIDATION_ERROR', "decision must be 'approved' or 'rejected'", { status: 400 });
    }
    if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
      // MD §11.5: 人工批准 = real human. No actor = no approval.
      throw new TaskRunError('APPROVAL_REQUIRES_HUMAN', 'Approval requires a human actor', { status: 403 });
    }
    const approval = await db.approvalRequest.findUnique({ where: { id: approvalId } });
    if (!approval) {
      throw new TaskRunError('APPROVAL_NOT_FOUND', `Approval ${approvalId} not found`, { status: 404 });
    }
    if (approval.status !== 'pending') {
      throw new TaskRunError('APPROVAL_ALREADY_RESOLVED', `Approval already ${approval.status}`, { status: 409 });
    }
    const updated = await db.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status: decision,
        reviewedBy: actorUserId,
        reviewedAt: new Date(),
        reviewNote: note ? String(note).slice(0, 500) : null,
      },
    });
    await recordEvent(approval.taskRunId, TASK_EVENT.APPROVAL_RESOLVED, {
      message: `approval ${decision} by ${actorUserId}`,
      payload: { approvalId, decision, by: actorUserId, note: note ?? null, tool: approval.toolName },
    });
    return updated;
  }

  // ----------------------------------------------------------------- worker
  /**
   * Worker job entry (MD §11.2 steps 3-4). Guards:
   *  - run gone / terminal → STALE (job is superseded or run deleted)
   *  - run.attempt !== job attempt → STALE (a manual retry superseded it)
   *  - cancel_requested before start → confirm cancelled, do NOT execute
   *  - otherwise → running + attempt_started
   * @returns {Promise<{status:'started'|'stale'|'cancelled', run:object}>}
   */
  async function startAttempt(runId, attempt) {
    const run = await loadRun(runId);
    if (TASK_RUN_TERMINAL.includes(run.status)) {
      return { status: 'stale', run, reason: `run already ${run.status}` };
    }
    if (run.attempt !== attempt) {
      return { status: 'stale', run, reason: `superseded (db attempt ${run.attempt} != job attempt ${attempt})` };
    }
    if (run.status === 'cancel_requested') {
      await markCancelled(run.id, { reason: 'cancel_before_start', attempt });
      return { status: 'cancelled', run };
    }
    const startedAt = new Date();
    const updated = await db.taskRun.update({
      where: { id: run.id },
      data: { status: 'running', startedAt },
    });
    await recordEvent(run.id, TASK_EVENT.ATTEMPT_STARTED, {
      message: `attempt ${attempt} started`,
      payload: { attempt },
    });
    return { status: 'started', run: updated };
  }

  /** running → needs_approval (a tool call is waiting on a human). */
  async function setWaitingApproval(runId, { approvalId, toolName, attempt }) {
    const run = await loadRun(runId);
    if (run.status !== 'running') {
      throw new TaskRunError('ILLEGAL_STATE_TRANSITION', `cannot wait for approval from '${run.status}'`, { status: 409 });
    }
    const updated = await db.taskRun.update({ where: { id: run.id }, data: { status: 'needs_approval' } });
    // The waiting_approval event itself is written by createApproval().
    void approvalId;
    void toolName;
    void attempt;
    return updated;
  }

  /** needs_approval → running (approval granted; execution resumes). */
  async function resumeFromApproval(runId) {
    const run = await loadRun(runId);
    assertTransition(run.status, 'running', run.id);
    const updated = await db.taskRun.update({ where: { id: run.id }, data: { status: 'running' } });
    await recordEvent(run.id, TASK_EVENT.STATUS, {
      message: 'approval granted — execution resumed',
      payload: { from: run.status, to: 'running' },
    });
    return updated;
  }

  /**
   * Terminal write (worker side). The ONLY writer of finished_at (MD §11.3).
   * `skipped` is reserved for P4 schedules.
   */
  async function finishRun(runId, {
    status,
    resultText = null,
    resultJson = null,
    errorCode = null,
    errorMessage = null,
    usage = null,
    attempt = null,
    preview = null,
  }) {
    if (!TASK_RUN_TERMINAL.includes(status) || status === 'skipped') {
      throw new TaskRunError('INVALID_TERMINAL', `finishRun: '${status}' is not a writable terminal status`, { status: 500 });
    }
    const run = await loadRun(runId);
    if (run.status === status) {
      return { run, idempotent: true };
    }
    assertTransition(run.status, status, run.id);

    const now = new Date();
    const data = {
      status,
      finishedAt: now,
      durationMs: durationOf(run, now),
      errorCode,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 1000) : null,
    };
    if (status === 'succeeded') {
      data.resultText = resultText ? String(resultText).slice(0, TASK_DEFAULTS.OUTPUT_MAX_CHARS) : null;
      data.resultJson = resultJson ?? null;
    } else {
      // Non-success terminals must not leave a misleading "result" behind.
      data.resultText = null;
      data.resultJson = null;
    }
    const updated = await db.taskRun.update({ where: { id: run.id }, data });

    const eventMap = { succeeded: TASK_EVENT.SUCCEEDED, failed: TASK_EVENT.FAILED, cancelled: TASK_EVENT.CANCELLED, timed_out: TASK_EVENT.TIMED_OUT };
    const payload = {
      attempt: attempt ?? run.attempt,
      durationMs: data.durationMs,
      errorCode: errorCode ?? null,
      errorMessage: data.errorMessage,
      usage: scrubObject(usage ?? null, TASK_DEFAULTS.EVENT_PREVIEW_CHARS),
    };
    if (status === 'succeeded' && preview !== undefined) payload.outputPreview = preview;
    await recordEvent(runId, eventMap[status], { message: `run ${status}`, payload });
    if (status === 'succeeded' && resultText) {
      await recordEvent(runId, TASK_EVENT.OUTPUT, {
        message: 'final output',
        payload: { chars: resultText.length, preview: String(resultText).slice(0, TASK_DEFAULTS.EVENT_PREVIEW_CHARS) },
      });
    }
    await expirePendingApprovals(run.id);
    return { run: updated, idempotent: false };
  }

  // ------------------------------------------------------------- reconcile
  /**
   * Boot-time reconciliation (MD §12.3: 唔可以靜默丟失任務).
   * Non-terminal runs whose `updatedAt` is older than staleMs have no live
   * executor (worker restart / queue flush) → make it honest + auditable:
   *   cancel_requested → cancelled ; anything else → failed (retryable by user).
   */
  async function reconcileStaleRuns({ staleMs = 10 * 60_000, now = new Date() } = {}) {
    const cutoff = new Date(now.getTime() - staleMs);
    const candidates = await db.taskRun.findMany({
      where: {
        status: { in: ['queued', 'running', 'needs_approval', 'cancel_requested'] },
        updatedAt: { lt: cutoff },
      },
    });
    const summary = { scanned: candidates.length, cancelled: 0, failed: 0, skipped: 0, errors: [] };
    for (const run of candidates) {
      try {
        if (run.status === 'cancel_requested') {
          await markCancelled(run.id, { reason: 'stale_reconciled' });
          summary.cancelled += 1;
        } else if (run.status === 'queued') {
          // Queued but never picked up: the job is gone (queue died).
          await safeSetStatus(run, 'failed', {
            errorCode: 'QUEUE_LOST',
            errorMessage: 'Queued job never executed (queue lost or worker restarted) — use retry',
            finishedAt: new Date(),
            durationMs: 0,
          });
          await recordEvent(run.id, TASK_EVENT.FAILED, {
            message: 'stale reconciliation: queue lost',
            payload: { errorCode: 'QUEUE_LOST', attempt: run.attempt },
          });
          summary.failed += 1;
        } else {
          // running / needs_approval without a live executor
          await safeSetStatus(run, 'failed', {
            errorCode: 'WORKER_RESTART',
            errorMessage: 'Executor lost (worker restart) while run was in flight — use retry',
            finishedAt: new Date(),
            durationMs: durationOf(run, new Date()),
          });
          await recordEvent(run.id, TASK_EVENT.FAILED, {
            message: 'stale reconciliation: worker restart',
            payload: { errorCode: 'WORKER_RESTART', fromStatus: run.status, attempt: run.attempt },
          });
          summary.failed += 1;
        }
      } catch (err) {
        summary.errors.push({ runId: run.id, error: err.message });
        log.error?.({ runId: run.id, error: err.message }, 'stale reconciliation item failed');
      }
    }
    return summary;
  }

  async function safeSetStatus(run, to, data) {
    assertTransition(run.status, to, run.id);
    return db.taskRun.update({ where: { id: run.id }, data: { status: to, ...data } });
  }

  function durationOf(run, now) {
    const start = run.startedAt ? new Date(run.startedAt) : run.queuedAt ? new Date(run.queuedAt) : run.createdAt ? new Date(run.createdAt) : now;
    const ms = now.getTime() - start.getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : 0;
  }

  return {
    // introspection / testing
    canTransition,
    assertTransition,
    recordEvent,
    // API side
    createRun,
    createSkippedRun,
    requestCancel,
    requestRetry,
    resolveApproval,
    // worker side
    startAttempt,
    setWaitingApproval,
    resumeFromApproval,
    markCancelled,
    finishRun,
    bumpAttempt,
    createApproval,
    listPendingApprovals,
    expirePendingApprovals,
    loadRun,
    reconcileStaleRuns,
  };
}

// -------------------------------------------------------------------- utils
/** Provider-level errors that the engine maps onto run failures. */
export function providerErrorToRun(error) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('PROVIDER_')) {
    return { errorCode: error.code, errorMessage: String(error.message).slice(0, 1000) };
  }
  return { errorCode: PROVIDER_ERROR.GENERIC, errorMessage: String(error?.message ?? error).slice(0, 1000) };
}

/** @returns {string} stable string for logs (never includes raw args). */
export function describeRun(run) {
  return `run ${run?.id ?? '?'} status=${run?.status ?? '?'} attempt=${run?.attempt ?? '?'}`;
}

export { safeStringify };
