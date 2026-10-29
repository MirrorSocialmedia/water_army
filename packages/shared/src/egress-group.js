/**
 * Egress-group model + serial scheduling (WA-IPGROUP, 鐵律 2: 同出口 IP 嚴禁併發).
 *
 * WHY: the scheduler had no notion of an egress group — BATCH-E2E-RERUN
 * recorded 3 machines on ONE gost exit running SIMULTANEOUSLY (violates the
 * 1IP:N iron rule 2; the Google/FB anti-ban goal). The per-account limiter
 * (GmailProvisionCounter, T5/ADR-030) throttles Gmail signup ATTEMPTS per
 * id/ip/day — it is a provisioning-axis rate limit, NOT egress serialization
 * of batch runs: different axis, different table, kept as is (the group gate
 * is strictly about "at most one batch run per exit at any instant").
 *
 * GROUP KEY DERIVATION (single source of truth — resolve here, nowhere else):
 *   1. explicit `identity.metadataJson.egressGroup` (operator label,
 *      /^[a-z0-9][a-z0-9._-]{0,63}$/ after lowercase trim) -> `grp:<label>`.
 *      This is the 1IP:N mechanism (ops model: 1 exit IP : 4 accounts): the
 *      W3 IdentityEgress.expectedEgressIp column is DB-UNIQUE (1:1 pinning,
 *      ADR-027), so N identities can NOT share an IP through the binding —
 *      the explicit label is how a fleet expresses "these identities exit
 *      together". Labels are plain operator metadata (pattern-validated,
 *      zero secrets — a proxy URL never enters a group key).
 *   2. pinned binding (IdentityEgress) -> `ip:<expectedEgressIp>` — legacy
 *      1:1 pinning. The unique column makes each ip: group a de-facto
 *      singleton; labels and ip: keys are DIFFERENT namespaces on purpose
 *      (a labeled fleet never accidentally joins an ip: group and vice
 *      versa) — correctness over cleverness, the operator opts in.
 *   3. fallback -> `identity:<identityId>` (SINGLETON: no cross-identity
 *      constraint; identity exclusivity already holds via the reservation
 *      CAS). Unconfigured fleets keep today's behaviour EXACTLY (zero
 *      regression) — the gate short-circuits for singletons.
 *
 * ZERO-OVERLAP ENFORCEMENT (two layers, both DB-backed => multi-replica):
 *   - soft gate (scheduler dispatch, ensureRuns): a member defers while the
 *     group has an active run or the jitter gap has not elapsed — the
 *     membership stays PENDING. This IS the `queued_group_wait` semantic:
 *     we REUSE PENDING rather than mint a new status (take, not accident —
 *     no FSM/DB-status change, cancel/pause/re-arm edges all keep working;
 *     the wait is observable via egressGroupStatus()).
 *   - hard gate (engine claim): an `egress_group` resourceLease (CAS on
 *     (resourceType, resourceKey), the same primitive as container_slot)
 *     acquired before the slot gate, renewed by the heartbeat, released on
 *     every exit path. Two replicas racing on one group: one wins the
 *     lease, the other defers — the soft gate alone leaves a one-tick race
 *     window; the lease closes it.
 *
 * RANDOM STAGGER (錯峰): after a terminal run lands, the NEXT run of the
 * SAME group waits `deterministicJitterMs` before dispatch/claim.
 * Distribution: UNIFORM over the integer range [minMs, maxMs] (default
 * 60_000..300_000 ms), drawn by FNV-1a over `<groupKey>|<prevRunId>` —
 * DETERMINISTIC so every scheduler replica computes the SAME deadline (no
 * shared state, no double-admit divergence) while being non-constant across
 * gaps (a fresh prevRunId per run => a fresh draw). minMs==maxMs degrades to
 * a constant (operator choice). AppSetting `egress.group_jitter_ms`,
 * valueJson `{ value: { minMs, maxMs } }`, integers 0..3_600_000, min>max
 * swapped; invalid => documented defaults.
 *
 * Self-exclusion rule: the run UNDER EVALUATION (excludeRunId) never gates
 * itself — its own queued row must not block its own claim, and its own
 * previous attempt (same run row) must not re-arm the jitter (retry pacing
 * is the engine's batchRetryDelayMs, a different knob).
 *
 * Zero npm deps; db/leaseSvc injected Prisma-shaped — fully hermetic.
 */
import { IDENTITY_ACTIVE_RUN_STATUSES } from './batch-constants.js';

/** resourceLease resourceType for the group exclusion lease. */
export const EGRESS_GROUP_LEASE_TYPE = 'egress_group';

/** AppSetting knob: valueJson `{ value: { minMs, maxMs } }` (admin-managed). */
export const APP_SETTING_EGRESS_GROUP_JITTER_MS = 'egress.group_jitter_ms';

/** Default stagger window (work order: 60–300s). */
export const EGRESS_GROUP_JITTER_DEFAULTS = Object.freeze({ minMs: 60_000, maxMs: 300_000 });

/** Hard ceiling for both bounds (1h — the max run deadline class). */
const JITTER_BOUND_MAX = 3_600_000;

/** Run terminal statuses (the jitter baseline — finishedAt must exist). */
const RUN_TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'timed_out', 'cancelled']);

const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ------------------------------------------------------------------ derivation
/** Normalize an explicit operator label -> `grp:<label>` (null = not set/invalid). */
export function egressGroupLabelFromMetadata(metadataJson) {
  const raw = metadataJson?.egressGroup;
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().toLowerCase();
  if (norm.length === 0 || !LABEL_RE.test(norm)) return null;
  return `grp:${norm}`;
}

/**
 * Resolve the group key for an identity.
 * @param {object} identity identity row (metadataJson matters)
 * @param {object|null} [binding] identityEgress row (expectedEgressIp matters) — null skips layer 2
 * @returns {string} `grp:<label>` | `ip:<ip>` | `identity:<uuid>`
 */
export function egressGroupKeyFor(identity, binding = null) {
  const explicit = egressGroupLabelFromMetadata(identity?.metadataJson);
  if (explicit) return explicit;
  const ip = binding?.expectedEgressIp;
  if (typeof ip === 'string' && ip.length > 0) return `ip:${ip}`;
  return `identity:${identity?.id ?? 'missing'}`;
}

/** Singleton = the identity gates only itself (identity exclusivity covers it — the gate short-circuits). */
export function isSingletonGroupKey(groupKey) {
  return typeof groupKey !== 'string' || groupKey.startsWith('identity:');
}

// ------------------------------------------------------------------ stagger (錯峰)
/**
 * Read the stagger window (AppSetting, admin-managed). Fail-safe: ANY read
 * failure or invalid shape => documented defaults (never blocks dispatch).
 * @returns {Promise<{minMs:number, maxMs:number, source:'appsetting'|'default'}>}
 */
export async function readEgressGroupJitter(db, { log } = {}) {
  try {
    const row = await db.appSetting.findUnique({ where: { key: APP_SETTING_EGRESS_GROUP_JITTER_MS } });
    const v = row?.valueJson?.value;
    const minMs = v?.minMs;
    const maxMs = v?.maxMs;
    const ok = Number.isInteger(minMs) && Number.isInteger(maxMs)
      && minMs >= 0 && maxMs >= 0 && minMs <= JITTER_BOUND_MAX && maxMs <= JITTER_BOUND_MAX;
    if (!ok) return { ...EGRESS_GROUP_JITTER_DEFAULTS, source: 'default' };
    // min>max: swap (honest, logged) — an admin typo must not silently disable staggering.
    if (minMs > maxMs) {
      log?.warn?.({ minMs, maxMs }, 'egress jitter AppSetting min>max — swapped');
      return { minMs: maxMs, maxMs: minMs, source: 'appsetting' };
    }
    return { minMs, maxMs, source: 'appsetting' };
  } catch {
    return { ...EGRESS_GROUP_JITTER_DEFAULTS, source: 'default' };
  }
}

/** FNV-1a (32-bit) over a UTF-8 string — stable across processes/replicas. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic uniform stagger draw: minMs + hash % (maxMs - minMs + 1).
 * UNIFORM over the closed integer range [minMs, maxMs] (FNV-1a avalanche
 * approximates uniformity; the RANGE — not a point-mass — is the security
 * property). Same inputs => same output on every replica (stateless
 * convergence); a fresh prevRunId per gap => a fresh draw per gap.
 */
export function deterministicJitterMs(groupKey, prevRunId, minMs, maxMs) {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(minMs, maxMs);
  if (hi === lo) return lo;
  return lo + (fnv1a32(`${groupKey}|${prevRunId}`) % (hi - lo + 1));
}

// ------------------------------------------------------------------ gate
/**
 * All identities of a group (bounded fleet scan — fleet is operator-sized,
 * dozens not millions; the scan replaces a schema change this ticket is not
 * allowed to verify on a live DB).
 * @returns {Promise<string[]> identityIds (includes the queried identity for non-singleton groups)}
 */
async function listGroupMemberIds(db, groupKey) {
  if (groupKey.startsWith('grp:')) {
    const label = groupKey.slice(4);
    const identities = await db.identity.findMany({});
    return identities
      .filter((i) => egressGroupLabelFromMetadata(i.metadataJson) === `grp:${label}`)
      .map((i) => i.id);
  }
  if (groupKey.startsWith('ip:')) {
    const bindings = await db.identityEgress.findMany({ where: { expectedEgressIp: groupKey.slice(3) } });
    return bindings.map((b) => b.identityId);
  }
  return [groupKey.slice('identity:'.length)];
}

/**
 * Evaluate the serial gate for one dispatch/claim decision.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {string} opts.groupKey resolved via egressGroupKeyFor
 * @param {() => Date} opts.now
 * @param {{minMs:number,maxMs:number}} [opts.jitter] window (default: AppSetting read)
 * @param {string|null} [opts.excludeRunId] the run under evaluation (self-exclusion)
 * @param {string|null} [opts.excludeBatchId] defensive: ignore this batch's runs entirely
 *   (default null — a cancelled run's finishedAt DOES re-arm the jitter: a
 *   pause-stop touched the exit too, safety-first)
 * @returns {Promise<{groupKey:string, allowed:boolean, reason:'free'|'singleton'|'group_busy'|'jitter_wait',
 *   activeRunId:string|null, activeRunStatus:string|null, nextEligibleAt:Date|null,
 *   jitterMs:number|null, prevRunId:string|null, memberCount:number}>}
 */
export async function evaluateEgressGroupGate({ db, groupKey, now, jitter = null, excludeRunId = null, excludeBatchId = null, log } = {}) {
  if (isSingletonGroupKey(groupKey)) {
    return { groupKey, allowed: true, reason: 'singleton', activeRunId: null, activeRunStatus: null, nextEligibleAt: null, jitterMs: null, prevRunId: null, memberCount: 1 };
  }
  const window = jitter ?? await readEgressGroupJitter(db, { log });
  const memberIds = await listGroupMemberIds(db, groupKey);

  // 1) group busy? (any member with an active run — queued counts: it owns
  //    the next claim slot; same rationale as IDENTITY_ACTIVE_RUN_STATUSES)
  let active = null;
  let latestTerminal = null;
  for (const memberId of memberIds) {
    const runs = await db.taskRun.findMany({ where: { identityId: memberId } });
    for (const r of runs) {
      if (excludeRunId && r.id === excludeRunId) continue;
      if (excludeBatchId && r.batchId === excludeBatchId) continue;
      if (IDENTITY_ACTIVE_RUN_STATUSES.includes(r.status)) {
        if (!active || new Date(r.queuedAt ?? 0) > new Date(active.queuedAt ?? 0)) active = r;
      } else if (RUN_TERMINAL_STATUSES.includes(r.status) && r.finishedAt) {
        if (!latestTerminal || new Date(r.finishedAt) > new Date(latestTerminal.finishedAt)) latestTerminal = r;
      }
    }
  }
  if (active) {
    return { groupKey, allowed: false, reason: 'group_busy', activeRunId: active.id, activeRunStatus: active.status, nextEligibleAt: null, jitterMs: null, prevRunId: null, memberCount: memberIds.length };
  }

  // 2) stagger not elapsed since the group's last terminal run?
  if (latestTerminal) {
    const jitterMs = deterministicJitterMs(groupKey, latestTerminal.id, window.minMs, window.maxMs);
    const nextEligibleAt = new Date(new Date(latestTerminal.finishedAt).getTime() + jitterMs);
    if (now().getTime() < nextEligibleAt.getTime()) {
      return { groupKey, allowed: false, reason: 'jitter_wait', activeRunId: null, activeRunStatus: null, nextEligibleAt, jitterMs, prevRunId: latestTerminal.id, memberCount: memberIds.length };
    }
  }
  return { groupKey, allowed: true, reason: 'free', activeRunId: null, activeRunStatus: null, nextEligibleAt: null, jitterMs: null, prevRunId: latestTerminal?.id ?? null, memberCount: memberIds.length };
}

// ------------------------------------------------------------------ lease helpers (engine hard gate)
/**
 * Acquire the group exclusion lease for a run (CAS — the winner is the one
 * acquire() names). ttlMs should equal the slot TTL (both renewed by the
 * same heartbeat loop).
 */
export async function acquireGroupLease(leaseSvc, { groupKey, runId, ttlMs }) {
  return leaseSvc.acquire({ resourceType: EGRESS_GROUP_LEASE_TYPE, resourceKey: groupKey, ownerRunId: runId, ownerLabel: `egress:${groupKey.slice(0, 40)}`, ttlMs });
}

export async function releaseGroupLease(leaseSvc, { groupKey, runId }) {
  return leaseSvc.release({ resourceType: EGRESS_GROUP_LEASE_TYPE, resourceKey: groupKey, ownerRunId: runId });
}

export async function renewGroupLease(leaseSvc, { groupKey, runId, ttlMs }) {
  return leaseSvc.renew({ resourceType: EGRESS_GROUP_LEASE_TYPE, resourceKey: groupKey, ownerRunId: runId, ttlMs });
}

/**
 * Resolve an identity's group key including its pinned binding lookup.
 * (The single resolution point for scheduler + engine — never re-spell.)
 */
export async function resolveIdentityGroupKey(db, identity) {
  let binding = null;
  try {
    binding = await db.identityEgress.findUnique({ where: { identityId: identity.id } });
  } catch {
    binding = null; // table unavailable (older fake/db) => explicit-or-singleton
  }
  return egressGroupKeyFor(identity, binding);
}

// ------------------------------------------------------------------ observability
/**
 * Fleet egress-group status (work order: group待行數 + 下次放行估計).
 * Secret-free by construction: keys are labels/IP literals/uuids only.
 *
 * @returns {Promise<Array<{groupKey:string, memberIds:string[], activeRunId:string|null,
 *   activeRunStatus:string|null, waitingRunIds:string[], pendingMemberCount:number,
 *   lastFinishedAt:string|null, nextEligibleAt:string|null, jitterWindowMs:{minMs:number,maxMs:number} }>>}
 */
export async function egressGroupStatus(db, { now = () => new Date(), jitter = null, log } = {}) {
  const window = jitter ?? await readEgressGroupJitter(db, { log });
  const identities = await db.identity.findMany({});
  let bindings = [];
  try {
    bindings = await db.identityEgress.findMany({});
  } catch {
    bindings = [];
  }
  const bindingById = new Map(bindings.map((b) => [b.identityId, b]));

  // Bucket members by resolved key.
  const groups = new Map();
  for (const identity of identities) {
    const key = egressGroupKeyFor(identity, bindingById.get(identity.id) ?? null);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(identity.id);
  }

  const runs = await db.taskRun.findMany({});
  const runsByIdentity = new Map();
  for (const r of runs) {
    if (!r.identityId) continue;
    if (!runsByIdentity.has(r.identityId)) runsByIdentity.set(r.identityId, []);
    runsByIdentity.get(r.identityId).push(r);
  }

  // PENDING memberships of RUNNING batches per identity (待行數).
  const runningBatches = await db.batch.findMany({ where: { status: 'RUNNING' } });
  const runningBatchIds = new Set(runningBatches.map((b) => b.id));
  const pendingByIdentity = new Map();
  if (runningBatchIds.size) {
    const memberships = await db.batchIdentity.findMany({ where: { status: 'PENDING' } });
    for (const m of memberships) {
      if (!runningBatchIds.has(m.batchId)) continue;
      pendingByIdentity.set(m.identityId, (pendingByIdentity.get(m.identityId) ?? 0) + 1);
    }
  }

  const out = [];
  for (const [groupKey, memberIds] of groups) {
    // Observability covers REAL groups only: a singleton has no queue to
    // observe (its gate short-circuits — per-identity exclusivity already
    // exists), and dumping one row per identity would bloat the payload.
    if (isSingletonGroupKey(groupKey)) continue;
    const memberRuns = memberIds.flatMap((id) => runsByIdentity.get(id) ?? []);
    const active = memberRuns
      .filter((r) => IDENTITY_ACTIVE_RUN_STATUSES.includes(r.status))
      .sort((a, b) => new Date(b.queuedAt ?? 0) - new Date(a.queuedAt ?? 0))[0] ?? null;
    const terminal = memberRuns
      .filter((r) => RUN_TERMINAL_STATUSES.includes(r.status) && r.finishedAt)
      .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt))[0] ?? null;
    let nextEligibleAt = null;
    if (!active && terminal) {
      const jitterMs = isSingletonGroupKey(groupKey)
        ? 0
        : deterministicJitterMs(groupKey, terminal.id, window.minMs, window.maxMs);
      const t = new Date(new Date(terminal.finishedAt).getTime() + jitterMs);
      if (t.getTime() > now().getTime()) nextEligibleAt = t;
    }
    out.push({
      groupKey,
      memberIds,
      activeRunId: active?.id ?? null,
      activeRunStatus: active?.status ?? null,
      waitingRunIds: memberRuns.filter((r) => r.status === 'queued').map((r) => r.id),
      // 待行數: PENDING memberships minus the member currently ON the exit
      // (dispatched-but-unclaimed still counts as waiting — honest edge).
      pendingMemberCount: Math.max(0, memberIds.reduce((n, id) => n + (pendingByIdentity.get(id) ?? 0), 0)
        - (active && ['running', 'recovering'].includes(active.status) ? (pendingByIdentity.get(active.identityId) ?? 0) : 0)),
      lastFinishedAt: terminal?.finishedAt ?? null,
      nextEligibleAt,
      jitterWindowMs: isSingletonGroupKey(groupKey) ? { minMs: 0, maxMs: 0 } : { minMs: window.minMs, maxMs: window.maxMs },
    });
  }
  out.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
  return out;
}
