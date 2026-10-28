/**
 * BatchService — the SINGLE owner of batch/identity state (BR-B1, 施工 MD
 * §3/§6/§9/§10). Mirrors the TaskRunService pattern (工單 §11.3): no route
 * may set an identity or batch status directly — every transition goes
 * through this service, is compare-and-set in the DB, and leaves a
 * `state_events` row (MD §6.1: 每一次轉換都寫入 state_events).
 *
 * Zero npm dependencies: db is injected (Prisma-shaped / fake-shaped), so
 * unit + integration tests run hermetically.
 *
 * Persistence (MD §9): PostgreSQL is the source of truth. Rejected
 * transitions are ALSO written as events (toState = current state,
 * details.rejected = true, details.attemptedTo = target) so an audit can
 * show that someone attempted it.
 */
import {
  IDENTITY_STATUS,
  IDENTITY_TERMINAL,
  IDENTITY_TRANSITIONS,
  IDENTITY_TYPE_REGISTRY,
  BATCH_STATUS,
  BATCH_TERMINAL,
  BATCH_TRANSITIONS,
  IDENTITY_ACTIVE_RUN_STATUSES,
  IDEMPOTENCY_KEY_RE,
  BatchError,
  planCycle,
  validateCapacityInput,
  validateBatchConfig,
  validateIdentityDataPath,
  identityDataPaths,
  findDuplicateMountSources,
  newUuid,
} from './batch-constants.js';
import { scrubObject } from './scrub.js';

/** Credential-shaped metadata keys are refused at the boundary (MD §9.1). */
const SECRET_KEY_RE = /passw|token|cookie|secret|credential|api_?key|auth|session/i;
const EVENT_PREVIEW_CHARS = 1_000;

/**
 * @param {object} deps
 * @param {object} deps.db Prisma client (or fake) — needs identity/batch/batchIdentity/stateEvent/taskRun + $transaction
 * @param {object} [deps.log]
 * @param {() => Date} [deps.now] injectable clock
 * @param {string} [deps.dataRoot] canonical identity data root (MD §4.1)
 */
export function createBatchService({ db, log = console, now = () => new Date(), dataRoot = '/data/water_army/identities' } = {}) {
  if (!db || typeof db.identity?.findUnique !== 'function' || typeof db.batch?.findUnique !== 'function') {
    throw new TypeError('createBatchService: db needs identity + batch delegates');
  }

  // ------------------------------------------------------------------ events
  /**
   * Append a state event (MD §9.5). details are scrubbed (no secrets ever
   * reach state_events). Never throws the request down for an event failure —
   * same contract as the audit service — the state row itself is the truth.
   *
   * @param {object} p
   * @param {object} [p.client] the db handle to write on — inside a
   *   transaction this MUST be the tx handle, or the event escapes the
   *   transaction's atomicity (a createCycle failure would then leave
   *   orphan events). Defaults to the outer db.
   */
  async function recordStateEvent({ entityType, entityId, fromState, toState, reason = null, actor = null, correlationId = null, details = null, client = db }) {
    try {
      await client.stateEvent.create({
        data: {
          entityType,
          entityId,
          fromState: fromState ?? null,
          toState,
          reason: reason ? String(reason).slice(0, 500) : null,
          actor: actor ? String(actor).slice(0, 128) : null,
          correlationId: correlationId ? String(correlationId).slice(0, 64) : null,
          detailsJson: scrubObject(details ?? {}, EVENT_PREVIEW_CHARS),
        },
      });
    } catch (err) {
      log.error?.({ entityType, entityId, toState, error: err.message }, 'state event write failed');
    }
  }

  // ------------------------------------------------------------- transitions
  function canTransitionIdentity(from, to) {
    return (IDENTITY_TRANSITIONS[from] ?? []).includes(to);
  }
  function canTransitionBatch(from, to) {
    return (BATCH_TRANSITIONS[from] ?? []).includes(to);
  }

  /**
   * Central identity transition (MD §6.1) — the ONLY writer of identity
   * status. CAS: the UPDATE is conditioned on the status we just read; a
   * concurrent writer wins → we 409 with the live state (no silent overwrite).
   * Illegal transitions are rejected AND leave a rejected event (MD §6.1).
   */
  async function transitionIdentity(identityId, to, { reason = null, actor = null, correlationId = null, details = null } = {}) {
    if (typeof identityId !== 'string' || identityId.length === 0) {
      throw new BatchError('IDENTITY_NOT_FOUND', 'Invalid identity id', { status: 404 });
    }
    if (!IDENTITY_STATUS.includes(to)) {
      throw new BatchError('UNKNOWN_STATE', `Unknown identity state '${to}'`);
    }
    const identity = await db.identity.findUnique({ where: { id: identityId } });
    if (!identity) throw new BatchError('IDENTITY_NOT_FOUND', `Identity ${identityId} not found`, { status: 404 });
    const from = identity.status;

    if (!canTransitionIdentity(from, to)) {
      await recordStateEvent({
        entityType: 'identity',
        entityId: identityId,
        fromState: from,
        toState: from,
        reason: `REJECTED ${from}→${to}${reason ? `: ${reason}` : ''}`.slice(0, 500),
        actor,
        correlationId,
        details: { rejected: true, attemptedTo: to, ...(details ?? {}) },
      });
      throw new BatchError('ILLEGAL_IDENTITY_TRANSITION', `Illegal identity transition: ${from} → ${to} (identity ${identityId})`, { status: 409 });
    }

    const ts = now();
    const res = await db.identity.updateMany({
      where: { id: identityId, status: from },
      data: { status: to, updatedAt: ts },
    });
    if (res.count === 0) {
      const live = await db.identity.findUnique({ where: { id: identityId } });
      throw new BatchError('ILLEGAL_IDENTITY_TRANSITION', `Identity ${identityId} changed concurrently (now '${live?.status ?? '?'}'); expected '${from}'`, { status: 409 });
    }
    await recordStateEvent({ entityType: 'identity', entityId: identityId, fromState: from, toState: to, reason, actor, correlationId, details });
    return { ...identity, status: to };
  }

  /**
   * Central batch transition (MD §3.3/§7) — the ONLY writer of batch status.
   * started_at / finished_at are maintained here (single writer rule).
   */
  async function transitionBatch(batchId, to, { reason = null, actor = null, correlationId = null, details = null } = {}) {
    if (typeof batchId !== 'string' || batchId.length === 0) {
      throw new BatchError('BATCH_NOT_FOUND', 'Invalid batch id', { status: 404 });
    }
    if (!BATCH_STATUS.includes(to)) {
      throw new BatchError('UNKNOWN_STATE', `Unknown batch state '${to}'`);
    }
    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BatchError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, { status: 404 });
    const from = batch.status;

    if (!canTransitionBatch(from, to)) {
      await recordStateEvent({
        entityType: 'batch',
        entityId: batchId,
        fromState: from,
        toState: from,
        reason: `REJECTED ${from}→${to}${reason ? `: ${reason}` : ''}`.slice(0, 500),
        actor,
        correlationId,
        details: { rejected: true, attemptedTo: to, ...(details ?? {}) },
      });
      throw new BatchError('ILLEGAL_BATCH_TRANSITION', `Illegal batch transition: ${from} → ${to} (batch ${batchId})`, { status: 409 });
    }

    const ts = now();
    const data = { status: to };
    if (to === 'RUNNING' && !batch.startedAt) data.startedAt = ts;
    if (BATCH_TERMINAL.includes(to)) data.finishedAt = ts;
    const res = await db.batch.updateMany({ where: { id: batchId, status: from }, data });
    if (res.count === 0) {
      const live = await db.batch.findUnique({ where: { id: batchId } });
      throw new BatchError('ILLEGAL_BATCH_TRANSITION', `Batch ${batchId} changed concurrently (now '${live?.status ?? '?'}'); expected '${from}'`, { status: 409 });
    }
    await recordStateEvent({ entityType: 'batch', entityId: batchId, fromState: from, toState: to, reason, actor, correlationId, details });
    return { ...batch, ...data };
  }

  // ------------------------------------------------------------------ plans
  /**
   * Pure preview (MD §7.2 DRY RUN) — NO writes, NO containers: returns the
   * exact plan a confirmed createCycle would persist.
   */
  function previewCycle({ identities, batchSize }) {
    return planCycle({ identities, batchSize });
  }

  /**
   * Create a confirmed cycle (MD §10 POST /api/batches — idempotency key
   * REQUIRED). Persists batches + batch_identities + state events in ONE
   * transaction; a redelivered key replays the ORIGINAL cycle (no second
   * cycle, no double binding).
   *
   * @param {object} input
   * @param {string} input.name
   * @param {string} input.idempotencyKey
   * @param {number} input.batchSize
   * @param {number} input.maxActiveContainers
   * @param {string} input.failurePolicy
   * @param {Array<{id:string, status?:string}>} input.identities identity rows (order = binding order)
   * @param {object} [input.config] batch config JSON (cooldowns, adapter, ...)
   * @param {string} [input.cycleId] explicit cycle id (default: fresh uuid)
   * @param {{id?:string, username?:string}} [input.user]
   * @returns {Promise<{replay:boolean, cycleId:string, batches:Array<{id:string,batchNo:number}>, plan:object}>}
   */
  async function createCycle(input, user = {}) {
    const errors = [];
    if (typeof input?.name !== 'string' || input.name.trim().length === 0 || input.name.length > 128) {
      errors.push('name must be a 1..128 char string');
    }
    if (typeof input?.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
      errors.push('idempotencyKey is required and must match ^[A-Za-z0-9_-]{8,64}$ (MD §10)');
    }
    errors.push(...validateCapacityInput(input ?? {}));
    // F-RDFA-1 (WA-RDFA-FIX): config is validated at CREATE time — before
    // anything is persisted. createCycle is the single cycle-write path, so
    // this is the API boundary: a malformed config (e.g. adapter = the
    // string "container", a missing image, an unknown adapter type) is a
    // 400 here, never a 201 that only dies as a 409 RUN_STATE_INVALID at
    // dispatch. validateBatchConfig is the single source of truth for the
    // config shape (shared with the worker-side re-check).
    errors.push(...validateBatchConfig(input?.config));
    if (!Array.isArray(input?.identities)) errors.push('identities must be an array');
    if (input?.identities && input.identities.some((i) => typeof i?.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(i.id))) {
      errors.push('every identity needs a uuid id');
    }
    if (errors.length) {
      throw new BatchError('VALIDATION_ERROR', `Invalid cycle plan: ${errors.join('; ')}`, { status: 400 });
    }

    // Idempotency first (replay returns the ORIGINAL cycle, MD §12.3).
    const replayRow = await db.batch.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (replayRow) {
      const siblings = await db.batch.findMany({ where: { cycleId: replayRow.cycleId }, orderBy: { batchNo: 'asc' } });
      return {
        replay: true,
        cycleId: replayRow.cycleId,
        batches: siblings.map((b) => ({ id: b.id, batchNo: b.batchNo, status: b.status })),
        plan: null, // full plan available via the batch detail read (B2)
      };
    }

    const plan = planCycle({ identities: input.identities, batchSize: input.batchSize });

    // Strict write path: every non-skipped membership must reference a real
    // identity row (FK). Preview tolerates unknown ids (it reports them);
    // create refuses them explicitly.
    const wantedIds = plan.batches.flatMap((b) => b.members.filter((m) => m.state === 'PENDING').map((m) => m.identityId));
    if (wantedIds.length) {
      const existing = await db.identity.findMany({ where: { id: { in: wantedIds } }, select: { id: true } });
      const missing = wantedIds.filter((id) => !existing.some((e) => e.id === id));
      if (missing.length) {
        throw new BatchError('VALIDATION_ERROR', `Unknown identities in cycle: ${missing.join(', ')}`, { status: 400 });
      }
      // NOTE (B2 G7): plan-time coexistence of two cycles sharing an identity
      // is INTENTIONALLY allowed (B1 contract — batch-idempotency tests: a
      // distinct idempotency key creates an independent cycle; MD §3.1 line
      // "同一 identity 最多只有一個 active run" is enforced at DISPATCH via
      // the reservation guard, not at plan time). A plan-time 409 here was
      // tried and reverted because it broke the shipped B1 behavior.
    }

    const cycleId = input.cycleId ?? newUuid();
    const ts = now();
    const created = [];
    await db.$transaction(async (tx) => {
      for (const b of plan.batches) {
        const batch = await tx.batch.create({
          data: {
            name: `${input.name.trim()} #${b.batchNo}`,
            cycleId,
            batchNo: b.batchNo,
            status: 'PLANNED',
            batchSize: b.size,
            maxActiveContainers: input.maxActiveContainers,
            failurePolicy: input.failurePolicy,
            configJson: input.config ?? {},
            // the cycle-level idempotency key lives on batch_no = 1
            idempotencyKey: b.batchNo === 1 ? input.idempotencyKey : null,
            createdBy: user?.id ?? null,
            createdAt: ts,
          },
        });
        created.push(batch);
        const skipped = b.members.filter((m) => m.state === 'SKIPPED');
        await recordStateEvent({
          entityType: 'batch',
          entityId: batch.id,
          fromState: null,
          toState: 'PLANNED',
          reason: 'cycle created',
          actor: user?.id ?? null,
          correlationId: cycleId,
          details: { name: input.name.trim(), skipped: skipped.map((m) => ({ position: m.position, identityId: m.identityId, reason: m.skipReason })) },
          client: tx, // INSIDE the transaction — an atomic cycle create
        });
        for (const m of b.members) {
          await tx.batchIdentity.create({
            data: {
              batchId: batch.id,
              identityId: m.identityId,
              position: m.position,
              status: m.state,
              skipReason: m.skipReason,
              createdAt: ts,
            },
          });
        }
      }
    });
    return {
      replay: false,
      cycleId,
      batches: created.map((b) => ({ id: b.id, batchNo: b.batchNo })),
      plan,
    };
  }

  // ------------------------------------------------------------------ guards
  /**
   * The identity-exclusivity guard (MD §14.1: the same identity holds at most
   * ONE active run). Returns the active run row or null.
   */
  async function findActiveRun(identityId) {
    if (typeof identityId !== 'string' || identityId.length === 0) return null;
    return db.taskRun.findFirst({ where: { identityId, status: { in: [...IDENTITY_ACTIVE_RUN_STATUSES] } } });
  }

  /**
   * Reserve an identity for a run (MD §6.1 READY → RESERVED), guarded:
   *  - identity must be READY
   *  - no other active run may exist for this identity (409 ACTIVE_RUN_EXISTS)
   * The B2 scheduler calls this AFTER creating the run row and BEFORE
   * dispatching; the run row itself carries identity_id (set at create time).
   */
  async function reserveIdentityForRun({ identityId, runId, actor = null, correlationId = null, reason = null } = {}) {
    if (typeof identityId !== 'string' || identityId.length === 0) {
      throw new BatchError('IDENTITY_NOT_FOUND', 'Invalid identity id', { status: 404 });
    }
    const identity = await db.identity.findUnique({ where: { id: identityId } });
    if (!identity) throw new BatchError('IDENTITY_NOT_FOUND', `Identity ${identityId} not found`, { status: 404 });
    if (identity.status !== 'READY') {
      throw new BatchError('IDENTITY_NOT_READY', `Identity ${identityId} is '${identity.status}', must be READY to reserve`, { status: 409 });
    }
    const active = await findActiveRun(identityId);
    if (active) {
      await recordStateEvent({
        entityType: 'identity',
        entityId: identityId,
        fromState: identity.status,
        toState: identity.status,
        reason: `REJECTED READY→RESERVED: active run ${active.id}`,
        actor,
        correlationId,
        details: { rejected: true, attemptedTo: 'RESERVED', activeRunId: active.id, requestedRunId: runId ?? null },
      });
      throw new BatchError('ACTIVE_RUN_EXISTS', `Identity ${identityId} already has an active run (${active.id})`, { status: 409 });
    }
    return transitionIdentity(identityId, 'RESERVED', {
      reason: reason ?? `reserved for run ${runId ?? '(unbound)'}`,
      actor,
      correlationId,
      details: { runId: runId ?? null },
    });
  }

  // ------------------------------------------------------- completion (MD §3.3)
  /**
   * Evaluate whether a batch may (and how it should) complete (MD §3.3):
   *   - every identity must be in a terminal state, otherwise → incomplete
   *   - any FAILED_FINAL + failure_policy stop_batch        → PAUSED (human judgement)
   *   - any FAILED_FINAL + failure_policy continue_and_report → COMPLETED_WITH_ERRORS
   *   - all terminal, no FAILED_FINAL                        → COMPLETED
   * (SKIPPED counts as terminal — an approved skip, MD §3.3.)
   *
   * @returns {Promise<{complete:boolean, status:string, paused?:boolean, failedFinal:number, skipped:number, pending:number}>}
   */
  async function evaluateBatchCompletion(batchId, { actor = 'system', correlationId = null } = {}) {
    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new BatchError('BATCH_NOT_FOUND', `Batch ${batchId} not found`, { status: 404 });
    if (BATCH_TERMINAL.includes(batch.status)) {
      return { complete: true, status: batch.status, failedFinal: 0, skipped: 0, pending: 0 };
    }
    if (batch.status === 'PLANNED') {
      return { complete: false, status: batch.status, pending: -1, failedFinal: 0, skipped: 0 };
    }

    const memberships = await db.batchIdentity.findMany({ where: { batchId } });
    // The MEMBERSHIP is the per-batch completion source of truth (batch-constants:
    // "a batch is complete only when every membership is in IDENTITY_TERMINAL";
    // MD §3.3: SKIPPED counts as terminal — an approved skip). The identity's own
    // status may legitimately sit in a non-terminal CONFIG state while its
    // membership is terminal (e.g. DISABLED behind an approved SKIPPED membership —
    // DISABLED is not in IDENTITY_TERMINAL and never will be, it is a standing
    // admin state, not a run-lifecycle state). Counting the identity status here
    // wedged the batch in RUNNING forever (BR-B6 E2E finding 2026-10-22: one
    // disabled skip in a 50-id batch blocked the whole cycle). Membership sync is
    // applied atomically with the run terminal transition, so a terminal
    // membership never lags a live run, and a run can never un-terminate —
    // the membership is safe as the criterion.
    let failedFinal = 0;
    let skipped = 0;
    let pending = 0;
    for (const m of memberships) {
      const s = m.status;
      if (s === 'FAILED_FINAL') failedFinal += 1;
      else if (s === 'SKIPPED') skipped += 1;
      if (!IDENTITY_TERMINAL.includes(s)) pending += 1;
    }
    if (pending > 0) {
      return { complete: false, status: batch.status, pending, failedFinal, skipped };
    }

    if (failedFinal > 0) {
      if (batch.failurePolicy === 'stop_batch') {
        if (batch.status === 'RUNNING') {
          await transitionBatch(batchId, 'PAUSED', {
            reason: `failure_policy stop_batch: ${failedFinal} FAILED_FINAL`,
            actor,
            correlationId: correlationId ?? batch.cycleId,
            details: { failedFinal, skipped },
          });
          return { complete: false, status: 'PAUSED', paused: true, failedFinal, skipped, pending: 0 };
        }
        // Already parked (or cancelling) — report, do not fight the state.
        return { complete: false, status: batch.status, paused: batch.status === 'PAUSED', failedFinal, skipped, pending: 0 };
      }
      await transitionBatch(batchId, 'COMPLETED_WITH_ERRORS', {
        reason: `all identities terminal; ${failedFinal} FAILED_FINAL (continue_and_report)`,
        actor,
        correlationId: correlationId ?? batch.cycleId,
        details: { failedFinal, skipped },
      });
      return { complete: true, status: 'COMPLETED_WITH_ERRORS', failedFinal, skipped, pending: 0 };
    }

    await transitionBatch(batchId, 'COMPLETED', {
      reason: `all identities terminal (${skipped} skipped)`,
      actor,
      correlationId: correlationId ?? batch.cycleId,
      details: { failedFinal: 0, skipped },
    });
    return { complete: true, status: 'COMPLETED', failedFinal: 0, skipped, pending: 0 };
  }

  // ---------------------------------------------------------------- identities
  /**
   * Create an identity row (MD §9.1). The dataPath is either caller-supplied
   * (validated against the canonical root) or derived from the (JS-generated)
   * uuid — UNIQUE in the DB, so a second identity can never claim the same
   * writable path (MD §4.1). Credential-shaped metadata keys are refused at
   * the boundary (MD §9.1: 禁止把密碼/cookie/token 放在 metadata).
   *
   * @param {object} input
   * @param {string} input.displayName
   * @param {string} input.identityType one of IDENTITY_TYPE_REGISTRY
   * @param {string} [input.externalRef]
   * @param {string} [input.dataPath]
   * @param {object} [input.metadata]
   * @param {{id?:string, username?:string}} [input.user]
   * @returns {Promise<{identity:object, replay:boolean}>}
   */
  async function createIdentity(input, user = {}) {
    const errors = [];
    if (typeof input?.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.length > 128) {
      errors.push('displayName must be a 1..128 char string');
    }
    if (!IDENTITY_TYPE_REGISTRY.includes(input?.identityType)) {
      errors.push(`identityType must be one of ${IDENTITY_TYPE_REGISTRY.join(' | ')} (MD §9.1 registry)`);
    }
    if (input?.externalRef != null && (typeof input.externalRef !== 'string' || input.externalRef.length > 64)) {
      errors.push('externalRef must be a 1..64 char string or null');
    }
    if (input?.metadata != null && (typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
      errors.push('metadata must be a plain object');
    } else if (input?.metadata != null) {
      for (const k of Object.keys(input.metadata)) {
        if (SECRET_KEY_RE.test(k)) {
          errors.push(`metadata key '${k}' looks credential-shaped and is forbidden (MD §9.1)`);
          break;
        }
      }
    }
    if (errors.length) {
      throw new BatchError('VALIDATION_ERROR', `Invalid identity: ${errors.join('; ')}`, { status: 400 });
    }

    const id = newUuid();
    let dataPath;
    if (input.dataPath != null) {
      const check = validateIdentityDataPath(dataRoot, input.dataPath);
      if (!check.ok) throw new BatchError('INVALID_DATA_PATH', `dataPath rejected: ${check.reason}`, { status: 400 });
      dataPath = check.canonical;
    } else {
      dataPath = identityDataPaths(id, dataRoot).data;
    }

    try {
      const identity = await db.identity.create({
        data: {
          id,
          externalRef: input.externalRef ?? null,
          displayName: input.displayName.trim(),
          identityType: input.identityType,
          status: 'READY',
          dataPath,
          metadataJson: scrubObject(input.metadata ?? {}, EVENT_PREVIEW_CHARS),
        },
      });
      await recordStateEvent({
        entityType: 'identity',
        entityId: id,
        fromState: null,
        toState: 'READY',
        reason: 'identity created',
        actor: user?.id ?? null,
        details: { displayName: identity.displayName, identityType: identity.identityType },
      });
      return { identity, replay: false };
    } catch (err) {
      const code = String(err?.code ?? '');
      if (code === 'P2002') {
        throw new BatchError('IDENTITY_CONFLICT', `Identity conflict (duplicate external_ref or data_path): ${err.message}`, { status: 409 });
      }
      throw err;
    }
  }

  return {
    // introspection
    canTransitionIdentity,
    canTransitionBatch,
    recordStateEvent,
    // plans
    previewCycle,
    createCycle,
    // transitions (single entry points)
    transitionIdentity,
    transitionBatch,
    // guards + reservation
    findActiveRun,
    reserveIdentityForRun,
    // completion
    evaluateBatchCompletion,
    // identity rows
    createIdentity,
  };
}
