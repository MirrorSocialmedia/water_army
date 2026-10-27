/**
 * T5 (ADR-030) — account lifecycle machine service.
 *
 * Sibling of the T2 login-state machine, hung next to the identity:
 *   login_state        human-only truth about the app login (ADR-029)
 *   account lifecycle  Gmail creation pipeline — system-writable + operator
 *                      override, every transition audited (this file).
 *
 * The authoritative matrix lives in @water-army/shared (gmail-provision.js);
 * web mirror + matrix unit test follow the ADR-029 §3 three-way discipline.
 * Fail-closed: anything outside the matrix (including self-transitions) is
 * 409; unknown states 400; unknown identity 404.
 *
 * Zero secrets: detailsJson carries scrubbed reason codes / step slugs only.
 * Credentials never transit this surface (they go straight to the vault).
 */
import { randomUUID } from 'node:crypto';

import {
  ACCOUNT_STATES,
  ACCOUNT_TRANSITIONS,
  isLegalAccountTransition,
} from '@water-army/shared';

function fail(code, status, message, details) {
  const err = new Error(message);
  err.apiCode = code;
  err.httpStatus = status;
  err.statusCode = status;
  if (details) err.details = details;
  throw err;
}

/**
 * @param {object} deps
 * @param {object} deps.db prisma (identity / accountLifecycle / accountLifecycleAudit)
 * @param {object} [deps.log]
 * @param {(e:object)=>Promise<void>} [deps.audit] platform audit fn
 */
export function createAccountLifecycleService({ db, log = { info() {}, warn() {}, error() {} }, audit } = {}) {
  async function assertIdentity(identityId) {
    const ident = await db.identity.findUnique({ where: { id: identityId } });
    if (!ident) fail('IDENTITY_NOT_FOUND', 404, `identity '${identityId}' not found`);
    return ident;
  }

  /** Load or create the PREPARING row (idempotent; P2002 → re-read). */
  async function ensure(identityId) {
    await assertIdentity(identityId);
    let row = await db.accountLifecycle.findUnique({ where: { identityId } });
    if (!row) {
      try {
        row = await db.accountLifecycle.create({
          data: { id: randomUUID(), identityId, state: 'PREPARING', stateSince: new Date() },
        });
      } catch (e) {
        if (e?.code !== 'P2002') throw e;
        row = await db.accountLifecycle.findUnique({ where: { identityId } });
      }
    }
    return row;
  }

  /** Viewer projection (zero secrets — states, step slug, reason codes). */
  function project(row) {
    return {
      identityId: row.identityId,
      state: row.state,
      stateSince: row.stateSince ?? null,
      currentStep: row.currentStep ?? null,
      awaitingDeadlineAt: row.awaitingDeadlineAt ?? null,
      interventionId: row.interventionId ?? null,
      failureCode: row.failureCode ?? null,
    };
  }

  async function getState(identityId) {
    const row = await ensure(identityId);
    return project(row);
  }

  async function listAudit(identityId, { limit = 50 } = {}) {
    await assertIdentity(identityId);
    const rows = await db.accountLifecycleAudit.findMany({
      where: { identityId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 50, 1), 200),
    });
    return { items: rows.map((r) => ({
      id: r.id,
      identityId: r.identityId,
      fromState: r.fromState,
      toState: r.toState,
      actorUserId: r.actorUserId ?? null,
      actorKind: r.actorKind,
      reasonCode: r.reasonCode ?? null,
      details: r.detailsJson ?? {},
      createdAt: r.createdAt,
    })) };
  }

  /**
   * The one audited write path for lifecycle state.
   * @param {string} identityId
   * @param {string} to target state
   * @param {object} opts
   * @param {string} [opts.actorUserId] human actor (route path); null = system
   * @param {'system'|'human'} [opts.actorKind='system']
   * @param {string} [opts.reasonCode] machine-readable reason (scrubbed slug)
   * @param {object} [opts.details] scrubbed metadata (step slugs / ids, no PII)
   * @param {object} [opts.set] extra column updates applied atomically with
   *        the transition (currentStep / awaitingDeadlineAt / interventionId /
   *        failureCode — driver bookkeeping rides the same write)
   */
  async function transition(identityId, to, { actorUserId = null, actorKind = 'system', reasonCode = null, details, set, requestId, ip } = {}) {
    if (!ACCOUNT_STATES.includes(to)) {
      fail('VALIDATION_ERROR', 400, `unknown account state '${to}' (allowed: ${ACCOUNT_STATES.join('|')})`);
    }
    const row = await ensure(identityId);
    const from = row.state;
    if (!isLegalAccountTransition(from, to)) {
      fail('INVALID_ACCOUNT_TRANSITION', 409,
        `account transition ${from} → ${to} is not allowed (allowed from ${from}: ${ACCOUNT_TRANSITIONS[from]?.join(', ') || 'none'}; self-transitions are rejected — a repeat action is a bug, not a no-op)`);
    }
    const clean = set ? Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)) : {};
    const now = new Date();
    await db.accountLifecycle.update({
      where: { identityId },
      data: { state: to, stateSince: now, ...clean },
    });
    const auditRow = await db.accountLifecycleAudit.create({
      data: {
        id: randomUUID(),
        lifecycleId: row.id,
        identityId,
        fromState: from,
        toState: to,
        actorUserId: actorUserId ?? null,
        actorKind: actorKind === 'human' ? 'human' : 'system',
        reasonCode: reasonCode ?? null,
        detailsJson: details ?? {},
        createdAt: now,
      },
    });
    if (audit) {
      await audit({
        actorUserId: actorUserId ?? null,
        action: 'identity.account.transition',
        resourceType: 'identity',
        resourceId: identityId,
        requestId: requestId ?? null,
        ip: ip ?? null,
        status: 'success',
        details: { from, to, reasonCode: reasonCode ?? null },
      }).catch((err) => log.warn?.({ error: err?.message }, 'account-lifecycle: audit write failed'));
    }
    return { ...project({ ...row, ...clean, state: to, stateSince: now }), auditId: auditRow.id };
  }

  /** Driver bookkeeping without a state change (step progress). */
  async function setStep(identityId, step) {
    await ensure(identityId);
    await db.accountLifecycle.update({ where: { identityId }, data: { currentStep: step } });
  }

  return { ensure, getState, listAudit, transition, setStep, project, __states: ACCOUNT_STATES, __matrix: ACCOUNT_TRANSITIONS };
}
