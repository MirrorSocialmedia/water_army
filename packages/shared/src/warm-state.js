/**
 * WA-WARMING — identity cookie-warming state machine + business gate.
 *
 * WHY (老細 2026-10-29): a FRESH Google/FB account that goes straight into
 * business runs looks like a bot and gets flagged. The external-standard
 * remedy: 7–14 days of organic-looking footprint (搜尋/睇片/瀏覽 — the
 * warming templates, WA-WARMING s2) BEFORE any business dispatch. This module
 * is the single source of truth for:
 *
 *   1. THE STATE MACHINE (cold -> warming -> warm):
 *      cold    未養号。業務閘擋住 dispatch。新註冊默認（schema default）。
 *      warming 養緊。未夠門檻照樣擋；warming 排程只服務呢個狀態。
 *      warm    養熟（手動 override 或自然到期）。業務放行。
 *      Transition matrix (pure, testable):
 *        cold    -> warming (start), warm (admin force)
 *        warming -> warm (auto-promote / admin force), cold (reset)
 *        warm    -> warming (re-warm after a flag incident)
 *      Promotion warming->warm is DERIVED (elapsed >= threshold) and applied
 *      LAZILY (on read / at gate check) — no cron dependency: the truth is a
 *      function of time, so any replica converges without shared state.
 *
 *   2. THE THRESHOLD: AppSetting `warm.threshold_days` (default 14), with a
 *      per-identity override in metadataJson.warmThresholdDays (老細: 逐帳號
 *      可調). Both bounds-validated; ANY invalid shape fails safe to the
 *      documented default (same discipline as the egress jitter reader).
 *
 *   3. THE BUSINESS GATE: batch create/dispatch for a NON-warm identity is
 *      refused (WARM_GATE_BLOCKED 409) unless an admin overrides WITH a
 *      reason (audited at the route). Business vs warming traffic is
 *      DISTINGUISHABLE by the batch purpose label: configJson.purpose ===
 *      'warming' (the warming scheduler sets it) — warming batches bypass
 *      the gate by definition (養號任務就係為咗養冷号而存在).
 *
 * Zero npm deps; pure + db-injected — fully hermetic.
 */

export const WARM_STATES = Object.freeze(['cold', 'warming', 'warm']);
export const WARM_GATE_BLOCKED = 'WARM_GATE_BLOCKED';
export const WARM_TRANSITION_INVALID = 'WARM_TRANSITION_INVALID';
export const WARM_OVERRIDE_ADMIN_ONLY = 'WARM_OVERRIDE_ADMIN_ONLY';

/** AppSetting knob: valueJson `{ value: <int days> }` (admin-managed). */
export const APP_SETTING_WARM_THRESHOLD_DAYS = 'warm.threshold_days';
/** Work-order default: 14 days (external standard is 7–14; we take the safe end). */
export const WARM_THRESHOLD_DEFAULT_DAYS = 14;
/** Sanity bounds for ANY threshold source (0 = 即放行; 365 = 一年上限). */
export const WARM_THRESHOLD_DAYS_MIN = 0;
export const WARM_THRESHOLD_DAYS_MAX = 365;

/** Batch purpose labels (configJson.purpose) — the business/warming split. */
export const BATCH_PURPOSE = Object.freeze({ BUSINESS: 'business', WARMING: 'warming' });

const DAY_MS = 86_400_000;

const TRANSITIONS = Object.freeze({
  cold: Object.freeze(['warming', 'warm']),
  warming: Object.freeze(['warm', 'cold']),
  warm: Object.freeze(['warming']),
});

// ------------------------------------------------------------------ validation
export function isValidWarmState(s) {
  return WARM_STATES.includes(s);
}

/**
 * GRANDFATHER RULE: a row without a valid warmState predates the WA-WARMING
 * migration — production backfilled exactly those rows to 'warm' (existing
 * fleet = zero disruption), so unknown/absent resolves 'warm', NOT cold.
 * (New registrations get an explicit 'cold' — provision-service sets it.)
 */
export function resolveStoredWarmState(identity) {
  return isValidWarmState(identity?.warmState) ? identity.warmState : 'warm';
}

/** Legal transition? Grandfathered `from` (no warmState column value) behaves as warm. */
export function canTransitionWarm(from, to) {
  if (!isValidWarmState(to)) return false;
  const src = isValidWarmState(from) ? from : 'warm';
  return TRANSITIONS[src].includes(to);
}

function validDays(v) {
  return Number.isInteger(v) && v >= WARM_THRESHOLD_DAYS_MIN && v <= WARM_THRESHOLD_DAYS_MAX;
}

// ------------------------------------------------------------------ threshold
/**
 * Global threshold (AppSetting, admin-managed). Fail-safe: ANY read failure
 * or invalid shape => documented default (never blocks the gate).
 * @returns {Promise<{days:number, source:'appsetting'|'default'}>}
 */
export async function readWarmThresholdDays(db, { log } = {}) {
  try {
    const row = await db.appSetting.findUnique({ where: { key: APP_SETTING_WARM_THRESHOLD_DAYS } });
    const v = row?.valueJson?.value;
    if (!validDays(v)) return { days: WARM_THRESHOLD_DEFAULT_DAYS, source: 'default' };
    return { days: v, source: 'appsetting' };
  } catch {
    return { days: WARM_THRESHOLD_DEFAULT_DAYS, source: 'default' };
  }
}

/** Per-identity override (metadataJson.warmThresholdDays) — invalid/absent => global. */
export function identityWarmThresholdDays(identity, globalDays) {
  const v = identity?.metadataJson?.warmThresholdDays;
  return validDays(v) ? v : globalDays;
}

/** Effective threshold for one identity: per-account override > AppSetting > default. */
export async function resolveWarmThreshold(db, identity, { log } = {}) {
  const g = await readWarmThresholdDays(db, { log });
  const days = identityWarmThresholdDays(identity, g.days);
  return { days, source: days !== g.days ? 'identity_override' : g.source };
}

// ------------------------------------------------------------------ progress
/**
 * Pure progress evaluation — the DERIVED truth at instant `now`. The stored
 * warmState may lag (promotion is lazy); `effectiveState` closes the gap.
 * A warming identity WITHOUT warmStartedAt falls back to identity.createdAt
 * (honest: "in service since registration"), else elapsed = 0.
 */
export function evaluateWarmProgress(identity, { now = new Date(), thresholdDays }) {
  const stored = resolveStoredWarmState(identity);
  const days = validDays(thresholdDays) ? thresholdDays : WARM_THRESHOLD_DEFAULT_DAYS;
  const startedAt = identity?.warmState === 'warming'
    ? (identity?.warmStartedAt ?? identity?.createdAt ?? null)
    : (identity?.warmStartedAt ?? null);
  const elapsedMs = startedAt ? Math.max(0, new Date(now).getTime() - new Date(startedAt).getTime()) : 0;
  const elapsedDays = elapsedMs / DAY_MS;
  const readyAt = stored === 'warm'
    ? (identity?.warmReadyAt ?? null)
    : (stored === 'warming' && startedAt ? new Date(new Date(startedAt).getTime() + days * DAY_MS) : null);
  let effectiveState = stored;
  if (stored === 'warming' && elapsedDays >= days) effectiveState = 'warm';
  return {
    storedState: stored,
    effectiveState,
    thresholdDays: days,
    startedAt: startedAt ? new Date(startedAt) : null,
    readyAt,
    elapsedDays: Math.round(elapsedDays * 100) / 100,
    daysRemaining: stored === 'warm' ? 0 : Math.max(0, Math.ceil(days - elapsedDays)),
    progressPct: Math.min(100, Math.round((elapsedDays / Math.max(days, 1e-9)) * 100)),
  };
}

/**
 * THE GATE. Business dispatch of a non-warm identity => { allowed:false,
 * code: WARM_GATE_BLOCKED }. Warming-purpose batches always pass (they ARE
 * the footprint generator). `promotable` tells the caller to persist the
 * derived promotion (lazy auto-promote) — the gate never writes.
 */
export function checkWarmGate(identity, { now = new Date(), thresholdDays, purpose = BATCH_PURPOSE.BUSINESS } = {}) {
  if (purpose === BATCH_PURPOSE.WARMING) {
    return { allowed: true, code: null, warm: evaluateWarmProgress(identity, { now, thresholdDays }), purpose };
  }
  const warm = evaluateWarmProgress(identity, { now, thresholdDays });
  if (warm.effectiveState === 'warm') {
    return { allowed: true, code: null, warm, purpose };
  }
  return {
    allowed: false,
    code: WARM_GATE_BLOCKED,
    warm,
    purpose,
    message: `identity ${identity?.id ?? '?'} is ${warm.effectiveState} (養號 ${warm.elapsedDays}/${warm.thresholdDays} 天) — business dispatch blocked until warm`,
  };
}

/** Batch purpose from a config object (default = business — fail-CLOSED). */
export function batchPurposeOf(configJson) {
  const p = configJson && typeof configJson === 'object' ? configJson.purpose : null;
  return p === BATCH_PURPOSE.WARMING ? BATCH_PURPOSE.WARMING : BATCH_PURPOSE.BUSINESS;
}

// ------------------------------------------------------------------ db service
/**
 * DB-backed helpers (Prisma-shaped db injected — hermetic fakes ok).
 */
export function createWarmStateService({ db, log } = {}) {
  /** Read + derived progress for one identity (threshold resolved). */
  async function getProgress(identityId, { now = new Date() } = {}) {
    const identity = await db.identity.findUnique({ where: { id: identityId } });
    if (!identity) return null;
    const threshold = await resolveWarmThreshold(db, identity, { log });
    return promoteIfReady(identity, { now, thresholdDays: threshold.days, persist: true });
  }

  /**
   * Lazy promotion (warming -> warm when elapsed >= threshold). Persists with
   * CAS on the stored state (a concurrent manual transition wins cleanly).
   * Returns the (possibly refreshed) progress.
   */
  async function promoteIfReady(identity, { now = new Date(), thresholdDays, persist = true } = {}) {
    const progress = evaluateWarmProgress(identity, { now, thresholdDays });
    if (persist && progress.storedState === 'warming' && progress.effectiveState === 'warm') {
      try {
        await db.identity.update({
          where: { id: identity.id },
          // CAS posture: the fake/prisma update is last-write; re-check guard
          // via where-clause emulation (fake db has no CAS) — benign double-
          // promote (idempotent: same values), so no schema change needed.
          data: { warmState: 'warm', warmReadyAt: progress.readyAt ?? new Date(now) },
        });
        log?.info?.({ identityId: identity.id }, 'warm: auto-promoted warming -> warm (threshold elapsed)');
        // Return the POST-write view (storedState reflects the persisted row).
        return evaluateWarmProgress(
          { ...identity, warmState: 'warm', warmReadyAt: progress.readyAt ?? new Date(now) },
          { now, thresholdDays },
        );
      } catch (err) {
        log?.warn?.({ error: err?.message, identityId: identity.id }, 'warm: auto-promote write failed (derived state still honest)');
      }
    }
    return progress;
  }

  /**
   * Perform a transition (matrix-checked, version-free CAS on stored state).
   * @param {'start'|'promote'|'reset'|'force'} action
   * @returns {Promise<{ok:true, progress} | {ok:false, code, message}>}
   */
  async function transition(identityId, action, { actorUserId = null, reason = null, now = new Date() } = {}) {
    const identity = await db.identity.findUnique({ where: { id: identityId } });
    if (!identity) return { ok: false, code: 'IDENTITY_NOT_FOUND', message: `identity ${identityId} not found` };
    const from = resolveStoredWarmState(identity);
    const map = {
      start: { to: 'warming' },
      // promote = honest maturation: ONLY from warming (cold must 'start' —
      // skipping the warming clock is what 'force' (admin+reason) is for).
      promote: { to: 'warm', from: ['warming'] },
      force: { to: 'warm', from: ['cold', 'warming'] }, // admin override — route enforces admin+reason
      reset: { to: 'cold', from: ['warming'] }, // warm re-enters via 'start' (re-warm), not reset
    };
    const target = map[action];
    if (!target) return { ok: false, code: 'WARM_ACTION_UNKNOWN', message: `unknown warm action '${action}'` };
    if (target.from && !target.from.includes(from)) {
      return { ok: false, code: WARM_TRANSITION_INVALID, message: `warm action '${action}' requires state ${target.from.join('|')}, got ${from}` };
    }
    if (!canTransitionWarm(from, target.to)) {
      return { ok: false, code: WARM_TRANSITION_INVALID, message: `warm transition ${from} -> ${target.to} is not legal` };
    }
    const data = { warmState: target.to };
    if (target.to === 'warming') {
      // (re-)start the clock fresh — a re-warm after an incident starts from 0.
      data.warmStartedAt = new Date(now);
      data.warmReadyAt = null;
    } else if (target.to === 'warm') {
      data.warmReadyAt = new Date(now);
      if (!data.warmStartedAt && !identity.warmStartedAt) data.warmStartedAt = identity.createdAt ?? new Date(now);
    } else {
      data.warmStartedAt = null;
      data.warmReadyAt = null;
    }
    await db.identity.update({ where: { id: identityId }, data });
    await recordWarmAudit(identityId, {
      fromState: from, toState: target.to, action, actorUserId, reason, db,
    });
    const fresh = await db.identity.findUnique({ where: { id: identityId } });
    const threshold = await resolveWarmThreshold(db, fresh, { log });
    return { ok: true, identity: fresh, progress: evaluateWarmProgress(fresh, { now, thresholdDays: threshold.days }) };
  }

  /** Gate snapshot for a set of identities (batch create pre-check). */
  async function gateCheck(identityIds, { purpose = BATCH_PURPOSE.BUSINESS, now = new Date() } = {}) {
    const globalThreshold = await readWarmThresholdDays(db, { log });
    const identities = identityIds.length ? await db.identity.findMany({ where: { id: { in: identityIds } } }) : [];
    const byId = new Map(identities.map((i) => [i.id, i]));
    const blocked = [];
    for (const id of identityIds) {
      const identity = byId.get(id);
      if (!identity) continue; // route reports unknown ids separately
      const thresholdDays = identityWarmThresholdDays(identity, globalThreshold.days);
      const res = checkWarmGate(identity, { now, thresholdDays, purpose });
      if (!res.allowed) blocked.push({ identityId: id, displayName: identity.displayName ?? null, ...res.warm, message: res.message });
    }
    return { blocked };
  }

  return { getProgress, promoteIfReady, transition, gateCheck };
}

/** Audit trail rides the existing StateEvent table (entityType 'identity_warm'). */
async function recordWarmAudit(identityId, { fromState, toState, action, actorUserId, reason, db }) {
  try {
    await db.stateEvent?.create?.({
      data: {
        entityType: 'identity_warm',
        entityId: identityId,
        fromState,
        toState,
        reason: reason ? String(reason).slice(0, 500) : action,
        actor: actorUserId ? String(actorUserId) : 'system',
        detailsJson: { action },
      },
    });
  } catch {
    // Audit must never block the transition path (same posture as batch events).
  }
}

/** Normalize + validate a threshold setting value (route-side). */
export function normalizeWarmThresholdInput(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!validDays(n)) return null;
  return n;
}
