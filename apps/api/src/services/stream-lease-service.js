/**
 * StreamLeaseService — Mobile Console 5-screen streaming (MD §4.1/§8.1/§10/§11, ADR-019 §19.11).
 *
 * Concurrency model (MD §4.1 — no "count then insert"):
 *  - GLOBAL cap: atomic slot claim through the EXISTING resource_leases table
 *    (resourceType='stream_slot', resourceKey='slot-N', ownerRunId=this lease's
 *    own uuid) via createLeaseService.acquireSlot. The DB unique constraint
 *    [resource_type, resource_key] is the race guard — under N concurrent
 *    acquires exactly `maxStreams` win, the losers get NO_SLOT →
 *    STREAM_CAPACITY_REACHED (409, the fixed code chosen per MD §4.1).
 *  - PER-DEVICE: one active lease per device (MVP-strict, MD §4.1 allows
 *    "每設備一個 viewer session") enforced by the PARTIAL UNIQUE INDEX
 *    stream_leases_device_active_ux (status IN PENDING/ACTIVE) — the second
 *    concurrent inserter gets 23505 → STREAM_DEVICE_HELD (409).
 *  - owner/version CAS: every transition (heartbeat / close / expire /
 *    interrupt) is ONE updateMany carrying the expected version + status.
 *    A concurrent winner bumps version first; the loser matches 0 rows and
 *    MUST NOT touch the row (MD §4.1: 防誤刪新 lease).
 *
 * Time: SERVER time only (MD §4.1: 客戶端時間不能決定 lease 是否過期).
 *   `now` is injectable (deterministic hermetic tests).
 *
 * Stream ticket (MD §11.8): HMAC-SHA256, 60s TTL, binds sub(userId)+
 * dev(deviceId)+lease(leaseId)+mode. NV5b(c) (老細 2026-10-26 拍板): tickets
 * are IDEMPOTENT-UNTIL-SUCCESS — validation never burns the ticket; only a
 * successful WS handshake consumes it via consumeTicket() (Redis SET NX,
 * short-term coordination only — PG is the source of truth). A ticket that
 * already succeeded replays as STREAM_TICKET_REPLAYED (401); a failed
 * upgrade (sidecar down / restart storm) leaves the ticket spendable so the
 * browser can retry inside the TTL without burning its limiter budget on
 * fresh /reconnect calls. TTL, owner/lease binding and close/lease
 * invalidation are unchanged. No secret configured → 503
 * STREAM_TICKET_UNAVAILABLE (fail closed; never fall back to a guessable
 * secret).
 *
 * Reconciliation (MD §10):
 *  - reconcileStartup(): the issuing API process died → every PENDING/ACTIVE
 *    lease is INTERRUPTED + slot released. (P2 hook: consult the sidecar
 *    liveness registry before re-opening — a stream cannot silently survive
 *    its issuer.)
 *  - reconcileExpired(): ACTIVE + expiresAt < now → EXPIRED + slot released,
 *    version-guarded (a heartbeat that won the race is never reaped).
 */
import crypto from 'node:crypto';
import { ROLE_LEVEL } from '@water-army/shared';

const STREAM_SLOT_TYPE = 'stream_slot';
const MAX_STREAMS_HARD_CAP = 5; // MD §4.1: 值的最大可配置上限不得高於 5
const TICKET_TTL_MS = 60_000;
const TICKET_VERSION = 1;
const ACTIVE_STATUSES = ['PENDING', 'ACTIVE'];
const TERMINAL_STATUSES = ['CLOSED', 'EXPIRED', 'INTERRUPTED'];

/**
 * @param {object} deps
 * @param {object} deps.db Prisma client (device + streamLease + resourceLease delegates)
 * @param {object} deps.redis ioredis (or null — ticket replay store degrades to fail-closed)
 * @param {object} deps.config app config (maxConcurrentDeviceStreamsRaw, streamTicketSecret, streamLeaseTtlMs, streamReconcileIntervalMs)
 * @param {object} deps.log pino child logger
 * @param {(e:object) => Promise<void>} [deps.audit] audit fn (failures logged, never throw)
 * @param {object} [deps.leaseService] prebuilt createLeaseService (default: built from db)
 * @param {() => Date} [deps.now] injectable clock
 */
export function createStreamLeaseService({ db, redis = null, config = {}, log, audit = null, leaseService: injectedLease, now } = {}) {
  if (!db?.streamLease || typeof db.streamLease.findMany !== 'function') {
    throw new TypeError('createStreamLeaseService: db.streamLease delegate required');
  }
  const leaseService = injectedLease; // null ok — slot claims use it; see acquire()

  // --- config resolution (MD §4.1: default 5, cap 5, invalid → fail-safe 5) --
  function resolveMaxStreams() {
    const raw = config.maxConcurrentDeviceStreamsRaw;
    if (raw === undefined || raw === '') return MAX_STREAMS_HARD_CAP;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_STREAMS_HARD_CAP) {
      log.error(
        { raw, fallback: MAX_STREAMS_HARD_CAP },
        'config error: invalid MAX_CONCURRENT_DEVICE_STREAMS (must be integer 1..5) — safely falling back to 5 (MD §4.1: 非法值安全降至 5 + 明確設定錯誤，不可默默無上限)',
      );
      return MAX_STREAMS_HARD_CAP;
    }
    return n;
  }
  const maxStreams = resolveMaxStreams();
  const ttlMs = Number(config.streamLeaseTtlMs ?? 30_000);
  const secret = config.streamTicketSecret; // string; '' = ticketing unavailable

  function err(code, message, statusCode, details = null) {
    const e = new Error(message);
    e.apiCode = code;
    e.statusCode = statusCode;
    e.details = details;
    return e;
  }

  const clock = now ?? (() => new Date());
  const auditSafe = async (entry) => {
    if (!audit) return;
    try {
      await audit(entry);
    } catch (e) {
      log.warn({ error: e.message, action: entry.action }, 'stream lease audit write failed (non-fatal)');
    }
  };

  function assertTicketing() {
    if (typeof secret !== 'string' || secret.length < 16) {
      throw err('STREAM_TICKET_UNAVAILABLE', 'stream ticketing unavailable — STREAM_TICKET_SECRET not configured', 503);
    }
  }

  function timingSafeEq(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  // --- tickets (MD §11.8) ----------------------------------------------------
  function signPayload(b64) {
    return crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  }

  function issueTicket(lease) {
    assertTicketing();
    const payload = {
      v: TICKET_VERSION,
      sub: lease.userId,
      dev: lease.deviceId,
      lease: lease.id,
      mode: lease.mode,
      exp: clock().getTime() + TICKET_TTL_MS,
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${b64}.${signPayload(b64)}`;
  }

  function assertTicketStore() {
    if (!redis || typeof redis.set !== 'function' || typeof redis.get !== 'function') {
      throw err('STREAM_TICKET_UNAVAILABLE', 'stream ticket replay store unavailable', 503);
    }
  }

  function ticketKey(ticket) {
    return `mc:stream:ticket:${crypto.createHash('sha256').update(ticket).digest('hex')}`;
  }

  /**
   * Validate a ticket WITHOUT burning it (NV5b(c): idempotent until success).
   * Always rejects a ticket that has already been consumed (replay → 401
   * STREAM_TICKET_REPLAYED). The WS upgrade path validates here, opens the
   * sidecar tunnel, and only then calls consumeTicket() — a failed handshake
   * leaves the ticket spendable for a retry inside the TTL.
   *
   * `consume:true` is kept for callers that need validate-and-burn in one
   * shot (legacy single-use semantics); the upgrade path must NOT use it.
   *
   * @returns {Promise<object>} the ACTIVE lease row (server-time checked)
   */
  async function validateTicket({ ticket, user, deviceId, mode, consume = false }) {
    assertTicketing();
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) {
      throw err('STREAM_TICKET_INVALID', 'malformed stream ticket', 401);
    }
    const [b64, sig] = ticket.split('.');
    if (!timingSafeEq(sig, signPayload(b64))) {
      throw err('STREAM_TICKET_INVALID', 'stream ticket signature invalid', 401);
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    } catch {
      throw err('STREAM_TICKET_INVALID', 'stream ticket payload invalid', 401);
    }
    if (payload.v !== TICKET_VERSION || typeof payload.exp !== 'number' || payload.exp <= clock().getTime()) {
      throw err('STREAM_TICKET_INVALID', 'stream ticket expired', 401);
    }
    // Binding: user + device + lease + permission (MD §11.8 — 不能只靠可猜 device ID).
    if (payload.sub !== user.id || payload.dev !== deviceId || payload.mode !== mode) {
      throw err('STREAM_TICKET_INVALID', 'stream ticket binding mismatch (user/device/mode)', 401);
    }
    const lease = await db.streamLease.findUnique({ where: { id: payload.lease } });
    if (!lease || lease.status !== 'ACTIVE' || lease.id !== payload.lease || lease.deviceId !== deviceId || lease.userId !== user.id) {
      throw err('STREAM_TICKET_INVALID', 'stream ticket lease not active', 401);
    }
    assertTicketStore(); // replay bookkeeping is mandatory (NV5b(c) — fail closed without it)
    const key = ticketKey(ticket);
    if (await redis.get(key)) {
      throw err('STREAM_TICKET_REPLAYED', 'stream ticket already consumed (successful handshake, MD §11.8 NV5b(c))', 401);
    }
    if (consume) {
      const res = await redis.set(key, '1', 'EX', Math.ceil(TICKET_TTL_MS / 1000), 'NX');
      if (res !== 'OK') {
        throw err('STREAM_TICKET_REPLAYED', 'stream ticket already consumed (successful handshake, MD §11.8 NV5b(c))', 401);
      }
    }
    return lease;
  }

  /**
   * Mark a ticket CONSUMED — called ONLY after the WS upgrade completed a
   * successful sidecar handshake (NV5b(c): 「成功 handshake 先消耗」). A
   * concurrent duplicate that raced past validation loses here: SET NX fails
   * → 401 STREAM_TICKET_REPLAYED and the loser tears its tunnel down.
   * Key TTL outlives the ticket TTL, so the consumed marker can never expire
   * while the ticket itself is still valid.
   */
  async function consumeTicket({ ticket }) {
    assertTicketing();
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) {
      throw err('STREAM_TICKET_INVALID', 'malformed stream ticket', 401);
    }
    assertTicketStore();
    const res = await redis.set(ticketKey(ticket), '1', 'EX', Math.ceil(TICKET_TTL_MS / 1000) + 30, 'NX');
    if (res !== 'OK') {
      throw err('STREAM_TICKET_REPLAYED', 'stream ticket already consumed (successful handshake, MD §11.8 NV5b(c))', 401);
    }
  }

  // --- helpers ----------------------------------------------------------------
  async function findLeaseOr404(leaseId) {
    let row;
    try {
      row = await db.streamLease.findUnique({ where: { id: leaseId } });
    } catch (e2) {
      if (String(e2?.code ?? '') === 'P2025') throw err('STREAM_LEASE_NOT_FOUND', `stream lease '${leaseId}' not found`, 404);
      throw e2;
    }
    if (!row) throw err('STREAM_LEASE_NOT_FOUND', `stream lease '${leaseId}' not found`, 404);
    return row;
  }

  async function releaseSlot(leaseId, slotIndex) {
    if (slotIndex == null || !leaseService) return;
    try {
      await leaseService.release({ resourceType: STREAM_SLOT_TYPE, resourceKey: `slot-${slotIndex}`, ownerRunId: leaseId });
    } catch (e) {
      // Slot release is best-effort at the lease-terminal edge; the slot
      // itself expires via its own resource-lease TTL + BR-B1 reconciliation.
      log.warn({ error: e.message, leaseId, slotIndex }, 'stream slot release failed (slot will self-expire)');
    }
  }

  function summarize(row) {
    // Zero secrets by construction: no ticket, no credentials, no adb material (MD §8.1/§13).
    return {
      id: row.id,
      deviceId: row.deviceId,
      userId: row.userId,
      mode: row.mode,
      status: row.status,
      version: row.version,
      slotIndex: row.slotIndex,
      createdAt: row.createdAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      expiresAt: row.expiresAt,
      closedAt: row.closedAt ?? null,
      closeReason: row.closeReason ?? null,
      correlationId: row.correlationId ?? null,
    };
  }

  async function usage() {
    const active = await db.streamLease.count({ where: { status: { in: ACTIVE_STATUSES } } });
    return { active: active.count ?? active, max: maxStreams };
  }

  async function heldOnDevice(deviceId) {
    return db.streamLease.findFirst({ where: { deviceId, status: { in: ACTIVE_STATUSES } }, orderBy: { createdAt: 'asc' } });
  }

  // --- acquire (MD §8.1 POST /devices/redroid/:id/streams) ---------------------
  /**
   * @param {object} p
   * @param {string} p.deviceId
   * @param {object} p.user req.user ({id, role, ...})
   * @param {'viewer'|'controller'} p.mode
   * @param {string} [p.requestId] correlation + audit
   * @param {string} [p.ip]
   */
  async function acquire({ deviceId, user, mode, requestId = null, ip = null }) {
    assertTicketing(); // MD §11: a stream without a verifiable ticket cannot be served
    if (!['viewer', 'controller'].includes(mode)) {
      throw err('STREAM_INVALID_MODE', `stream mode must be 'viewer' or 'controller' (got '${mode}')`, 400);
    }
    // RBAC (MD §8.1: controller 需要 operator；viewer 只讀按現有 RBAC).
    const needLevel = mode === 'controller' ? ROLE_LEVEL.operator : ROLE_LEVEL.viewer;
    const haveLevel = ROLE_LEVEL[user?.role] ?? 0;
    if (haveLevel < needLevel) {
      throw err('STREAM_PERMISSION_DENIED', `acquiring a ${mode} stream requires role >= ${mode === 'controller' ? 'operator' : 'viewer'} (got '${user?.role ?? 'anonymous'}')`, 403);
    }
    // Device existence + runnability (MD §8.1: 設備仍可連線).
    let device;
    try {
      device = await db.device.findUnique({ where: { id: deviceId } });
    } catch (e) {
      if (String(e?.code ?? '') === 'P2025') throw err('STREAM_DEVICE_NOT_FOUND', `device '${deviceId}' not found`, 404);
      throw e;
    }
    if (!device) throw err('STREAM_DEVICE_NOT_FOUND', `device '${deviceId}' not found`, 404);
    if (device.containerState !== 'running') {
      throw err('STREAM_DEVICE_NOT_RUNNING', `device is not running (containerState='${device.containerState}')`, 409);
    }
    // Fast per-device pre-check (the partial unique index is the true guard —
    // this only makes the common rejection cheap + informative).
    const held = await heldOnDevice(deviceId).catch((e) => {
      if (String(e?.code ?? '') === 'P2002') return null; // 23505 surface from a concurrent writer is decided below
      throw e;
    });
    if (held) {
      throw err('STREAM_DEVICE_HELD', `device already has an active stream (mode='${held.mode}', lease '${held.id}')`, 409);
    }

    const ts = clock();
    let row;
    try {
      row = await db.streamLease.create({
        data: {
          deviceId,
          userId: user.id,
          mode,
          status: 'PENDING',
          version: 1,
          lastHeartbeatAt: ts,
          expiresAt: new Date(ts.getTime() + ttlMs),
          correlationId: requestId,
        },
      });
    } catch (e) {
      if (String(e?.code ?? '') === 'P2002') {
        // Same-device race: the partial unique index gave the other writer the lease.
        throw err('STREAM_DEVICE_HELD', `device already has an active stream (concurrent acquire won)`, 409);
      }
      throw e;
    }

    // GLOBAL slot — atomic (MD §4.1). ownerRunId = this lease's own uuid.
    let slot = null;
    try {
      if (!leaseService) throw err('STREAM_CAPACITY_REACHED', 'stream slot allocator unavailable (resource_leases surface missing)', 503);
      const res = await leaseService.acquireSlot({
        resourceType: STREAM_SLOT_TYPE,
        totalSlots: maxStreams,
        ownerRunId: row.id,
        ownerLabel: `stream:${String(user.id).slice(0, 8)}`,
      });
      if (!res.acquired) {
        throw err('STREAM_CAPACITY_REACHED', `stream capacity reached: ${maxStreams}/${maxStreams} streams active`, 409);
      }
      slot = res.slot;
      // PENDING → ACTIVE (version-guarded; nobody else may touch a fresh PENDING row).
      const up = await db.streamLease.updateMany({
        where: { id: row.id, version: 1, status: 'PENDING' },
        data: { status: 'ACTIVE', slotIndex: slot, version: 2 },
      });
      if (up.count !== 1) {
        // Internal invariant breach (row changed mid-acquire) — roll back honestly.
        throw new Error('internal: stream lease PENDING row changed during acquire');
      }
    } catch (e) {
      // Compensation: release the claimed slot (if any) + delete the PENDING row.
      if (slot != null) await releaseSlot(row.id, slot);
      await db.streamLease.deleteMany({ where: { id: row.id, status: 'PENDING' } }).catch(() => {});
      if (e.apiCode) {
        await auditSafe({
          actorUserId: user.id,
          action: 'stream.lease.denied',
          resourceType: 'stream_lease',
          resourceId: null,
          requestId,
          ip,
          status: 'denied',
          details: { deviceId, mode, code: e.apiCode, reason: e.message },
        });
      }
      throw e;
    }

    row = await db.streamLease.findUnique({ where: { id: row.id } });
    const ticket = issueTicket(row);
    await auditSafe({
      actorUserId: user.id,
      action: 'stream.lease.created',
      resourceType: 'stream_lease',
      resourceId: row.id,
      requestId,
      ip,
      status: 'success',
      details: { deviceId, mode, slotIndex: slot, ttlMs }, // zero secrets: no ticket in audit (MD §13)
    });
    return {
      lease: summarize(row),
      ticket, // idempotent until success, 60s TTL (NV5b(c)) — passed to the WS layer, never logged (MD §11.8)
      streamWsPath: `/api/device-streams/${row.id}/ws`,
      usage: await usage(),
    };
  }

  // --- list (MD §8.1 GET /device-streams) --------------------------------------
  async function list() {
    const rows = await db.streamLease.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return { leases: rows.map(summarize), usage: await usage() };
  }

  // --- heartbeat (MD §8.1 POST /device-streams/:leaseId/heartbeat) --------------
  async function heartbeat({ leaseId, user, requestId = null, ip = null }) {
    const row = await findLeaseOr404(leaseId);
    const isOwner = row.userId === user.id;
    const isAdmin = (ROLE_LEVEL[user?.role] ?? 0) >= ROLE_LEVEL.admin;
    if (!isOwner && !isAdmin) {
      throw err('STREAM_LEASE_OWNER_MISMATCH', 'only the lease owner (or an administrator) may heartbeat this lease', 403);
    }
    // Bounded CAS retry (2 attempts) — a concurrent heartbeat bumps the version;
    // re-read and retry once before reporting a conflict.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const live = attempt === 0 ? row : await findLeaseOr404(leaseId);
      const ts = clock();
      if (live.status === 'EXPIRED' || (live.status === 'ACTIVE' && live.expiresAt.getTime() <= ts.getTime())) {
        throw err('STREAM_LEASE_EXPIRED', 'lease expired — re-authenticate with a new lease (MD §10: 不得因重連恢復過期控制權)', 409);
      }
      if (live.status !== 'ACTIVE') {
        throw err('STREAM_LEASE_CLOSED', `lease is ${live.status} — re-authenticate with a new lease`, 409);
      }
      const up = await db.streamLease.updateMany({
        where: { id: leaseId, version: live.version, status: 'ACTIVE', expiresAt: { gt: ts } },
        data: { lastHeartbeatAt: ts, expiresAt: new Date(ts.getTime() + ttlMs), version: live.version + 1 },
      });
      if (up.count === 1) {
        const fresh = await db.streamLease.findUnique({ where: { id: leaseId } });
        return { lease: summarize(fresh), usage: await usage() };
      }
      // version drifted (concurrent heartbeat won) → loop re-reads.
    }
    throw err('STREAM_LEASE_CONFLICT', 'lease changed concurrently — re-read and retry', 409);
  }

  // --- close (MD §8.1 DELETE /device-streams/:leaseId — idempotent) --------------
  async function close({ leaseId, user, reason = 'user_closed', requestId = null, ip = null }) {
    const row = await findLeaseOr404(leaseId);
    const isOwner = row.userId === user.id;
    const isAdmin = (ROLE_LEVEL[user?.role] ?? 0) >= ROLE_LEVEL.admin;
    if (!isOwner && !isAdmin) {
      throw err('STREAM_LEASE_OWNER_MISMATCH', 'only the lease owner (or an administrator) may close this lease', 403);
    }
    if (TERMINAL_STATUSES.includes(row.status)) {
      // Idempotent (MD §15: 同一 lease 重複 close 為冪等).
      return { lease: summarize(row), usage: await usage(), idempotent: true };
    }
    const ts = clock();
    const up = await db.streamLease.updateMany({
      where: { id: leaseId, version: row.version, status: { in: ACTIVE_STATUSES } },
      data: { status: 'CLOSED', closedAt: ts, closeReason: reason, slotIndex: null, version: row.version + 1 },
    });
    if (up.count === 1) {
      await releaseSlot(leaseId, row.slotIndex);
      await auditSafe({
        actorUserId: user.id,
        action: 'stream.lease.closed',
        resourceType: 'stream_lease',
        resourceId: leaseId,
        requestId,
        ip,
        status: 'success',
        details: { reason, mode: row.mode, deviceId: row.deviceId },
      });
    }
    const fresh = await db.streamLease.findUnique({ where: { id: leaseId } });
    return { lease: summarize(fresh), usage: await usage(), idempotent: up.count === 0 };
  }

  // --- reconnect (MD §2.1.8 斷線重連 re-auth; ADR-019 §19.12; NV5b(c)) ----------
  /**
   * Re-issue a ticket for an ACTIVE lease the caller owns (or admin).
   * This is the ONLY way a dropped browser WS reconnects: a fresh ticket +
   * full server-side re-verification at the new WS upgrade (MD §2.1.8 — an
   * expired/revoked lease never regains control by reconnecting alone).
   * NV5b(c): the ticket is spendable until a handshake succeeds — a sidecar
   * restart storm no longer burns tickets at validation time.
   */
  async function reconnect({ leaseId, user, requestId = null, ip = null }) {
    const row = await findLeaseOr404(leaseId);
    const isOwner = row.userId === user.id;
    const isAdmin = (ROLE_LEVEL[user?.role] ?? 0) >= ROLE_LEVEL.admin;
    if (!isOwner && !isAdmin) {
      throw err('STREAM_LEASE_OWNER_MISMATCH', 'only the lease owner (or an administrator) may reconnect this lease', 403);
    }
    if (row.status !== 'ACTIVE') {
      throw err('STREAM_LEASE_CLOSED', `stream lease is ${row.status.toLowerCase()} (re-acquire to stream again)`, 409);
    }
    if (row.expiresAt <= clock()) {
      throw err('STREAM_LEASE_EXPIRED', 'stream lease expired (re-acquire for a fresh ticket)', 409);
    }
    const ticket = issueTicket(row);
    await auditSafe({
      actorUserId: user.id,
      action: 'stream.lease.reconnected',
      resourceType: 'stream_lease',
      resourceId: row.id,
      requestId,
      ip,
      status: 'success',
      details: { mode: row.mode, deviceId: row.deviceId }, // no ticket in audit (MD §13)
    });
    return {
      lease: summarize(row),
      ticket, // idempotent until success, 60s TTL (NV5b(c))
      streamWsPath: `/api/device-streams/${row.id}/ws`,
    };
  }

  // --- reconciliation (MD §10) ---------------------------------------------------
  /**
   * API-restart reconcile: the issuing process is dead → no stream of its can
   * be assumed alive. PENDING/ACTIVE → INTERRUPTED + slot released,
   * version-guarded (a row that already moved on is never clobbered).
   * P2 hook: before INTERRUPTED, consult the sidecar liveness registry — if
   * the sidecar independently owns the stream it may be RE-ADOPTED instead.
   */
  async function reconcileStartup() {
    const rows = await db.streamLease.findMany({ where: { status: { in: ACTIVE_STATUSES } } });
    let interrupted = 0;
    for (const row of rows) {
      const ts = clock();
      const up = await db.streamLease.updateMany({
        where: { id: row.id, version: row.version, status: { in: ACTIVE_STATUSES } },
        data: { status: 'INTERRUPTED', closedAt: ts, closeReason: 'api_restart', slotIndex: null, version: row.version + 1 },
      });
      if (up.count === 1) {
        await releaseSlot(row.id, row.slotIndex);
        interrupted += 1;
      }
    }
    if (interrupted > 0) {
      log.info({ interrupted }, 'stream lease startup reconcile: interrupted orphaned leases');
      await auditSafe({
        actorUserId: null,
        action: 'stream.lease.reaped',
        resourceType: 'stream_lease',
        resourceId: null,
        requestId: null,
        ip: null,
        status: 'success',
        details: { count: interrupted, reason: 'api_restart' },
      });
    }
    return interrupted;
  }

  /**
   * Expiry sweep (periodic): ACTIVE + expiresAt < now → EXPIRED + slot
   * released. The version in the WHERE is the CAS guard — a heartbeat that
   * renewed concurrently (version bumped, expiry extended) matches 0 rows and
   * survives (MD §4.1 owner/version 條件).
   * @returns {Promise<number>} count reaped
   */
  async function reconcileExpired() {
    const ts = clock();
    const cands = await db.streamLease.findMany({ where: { status: 'ACTIVE', expiresAt: { lt: ts } } });
    let reaped = 0;
    for (const row of cands) {
      const up = await db.streamLease.updateMany({
        where: { id: row.id, version: row.version, status: 'ACTIVE', expiresAt: { lt: ts } },
        data: { status: 'EXPIRED', closedAt: ts, closeReason: 'expired', slotIndex: null, version: row.version + 1 },
      });
      if (up.count === 1) {
        await releaseSlot(row.id, row.slotIndex);
        reaped += 1;
      }
    }
    if (reaped > 0) {
      log.info({ reaped }, 'stream lease expiry sweep: reaped expired leases');
      await auditSafe({
        actorUserId: null,
        action: 'stream.lease.reaped',
        resourceType: 'stream_lease',
        resourceId: null,
        requestId: null,
        ip: null,
        status: 'success',
        details: { count: reaped, reason: 'expired' },
      });
    }
    return reaped;
  }

  // --- periodic reconciler ---------------------------------------------------------
  let timer = null;
  function startReconciler() {
    const intervalMs = Number(config.streamReconcileIntervalMs ?? 15_000);
    if (intervalMs <= 0 || timer) return;
    let busy = false;
    timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await reconcileExpired();
      } catch (e) {
        log.warn({ error: e.message }, 'stream lease expiry sweep failed (will retry next tick)');
      } finally {
        busy = false;
      }
    }, intervalMs);
    timer.unref?.();
  }
  function stopReconciler() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    maxStreams,
    ttlMs,
    usage,
    acquire,
    list,
    heartbeat,
    close,
    reconnect,
    validateTicket,
    consumeTicket,
    reconcileStartup,
    reconcileExpired,
    startReconciler,
    stopReconciler,
  };
}
