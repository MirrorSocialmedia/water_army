/**
 * T2 (ADR-029) — identity LOGIN-STATE machine service.
 *
 * The identity-level truth about "is this account logged in on its device".
 * Four states (covering the operator's three required semantics + explicit
 * logout):
 *
 *   PENDING_LOGIN        待登入 — initial state (fresh / re-provisioned identity)
 *   CONFIRMED_LOGGED_IN  使用者已確認登入 — ONLY ever set by a human operator+
 *                        click. NEVER inferred: no probe, no worker, no AI may
 *                        advance into this state automatically.
 *   RELOGIN_REQUIRED     需重新驗證 — a human saw a credential challenge / 2FA
 *                        prompt / session-expiry; automation must stop here.
 *   LOGGED_OUT           已登出 — explicit manual logout (terminal-ish: the
 *                        only way out is back to PENDING_LOGIN).
 *
 * Transition legality is the matrix below (fail-closed: anything not listed
 * is 409 INVALID_TRANSITION, including self-transitions — a repeated click
 * is a bug, not a no-op, and deserves the noise). Every accepted transition
 * writes ONE audit row (who / when / evidence) in the same request.
 *
 * Lifecycle boundary (ADR-029): login state is IDENTITY-level, not device
 * level. A device may be removed and rebuilt (T2 provisioning flow) without
 * touching this state; the batch runtime (Identity.status) never reads or
 * writes loginState — the two axes are independent on purpose. T5 (account
 * lifecycle) extends THIS machine (e.g. BANNED / RETIRED as new states with
 * their own matrix rows), not a parallel table.
 *
 * Zero secrets: evidenceJson carries the operator note ONLY (length-capped);
 * passwords/cookies/tokens are rejected by shape, same rule as metadataJson.
 */

import { randomUUID } from 'node:crypto';

export const LOGIN_STATES = Object.freeze(['PENDING_LOGIN', 'CONFIRMED_LOGGED_IN', 'RELOGIN_REQUIRED', 'LOGGED_OUT']);

/** Fail-closed transition matrix: from → allowed tos. Anything else = 409. */
export const LOGIN_TRANSITIONS = Object.freeze({
  PENDING_LOGIN: Object.freeze(['CONFIRMED_LOGGED_IN', 'LOGGED_OUT']),
  CONFIRMED_LOGGED_IN: Object.freeze(['RELOGIN_REQUIRED', 'LOGGED_OUT']),
  RELOGIN_REQUIRED: Object.freeze(['CONFIRMED_LOGGED_IN', 'PENDING_LOGIN', 'LOGGED_OUT']),
  LOGGED_OUT: Object.freeze(['PENDING_LOGIN']),
});

/** Credential-shaped keys are rejected in evidence (MD §9.1 rule). */
const CREDENTIAL_KEY = /(pass(word)?|token|cookie|secret|credential|otp|session[_-]?id)/i;
const EVIDENCE_NOTE_MAX = 500;

function fail(code, status, message, details) {
  const err = new Error(message);
  err.apiCode = code;
  err.httpStatus = status;
  if (details) err.details = details;
  throw err;
}

export function isLegalLoginTransition(from, to) {
  return Boolean(LOGIN_TRANSITIONS[from]?.includes(to));
}

export function createLoginStateService({ db, log = { info() {}, warn() {}, error() {} }, audit } = {}) {
  /**
   * Load + project the login view (zero secrets). 404 when the identity is
   * unknown (same UUID-validation contract as the egress/fingerprint routes).
   */
  async function getLoginState(identityId) {
    const ident = await db.identity.findUnique({ where: { id: identityId } });
    if (!ident) fail('IDENTITY_NOT_FOUND', 404, `identity '${identityId}' not found`);
    return {
      identityId: ident.id,
      externalRef: ident.externalRef ?? null,
      displayName: ident.displayName,
      loginState: ident.loginState ?? 'PENDING_LOGIN',
      loginStateSince: ident.loginStateSince ?? null,
    };
  }

  /** GET audit trail (viewer+, newest first, capped). */
  async function listAudit(identityId, { limit = 50 } = {}) {
    const ident = await db.identity.findUnique({ where: { id: identityId } });
    if (!ident) fail('IDENTITY_NOT_FOUND', 404, `identity '${identityId}' not found`);
    const rows = await db.identityLoginAudit.findMany({
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
      evidence: r.evidenceJson ?? {},
      createdAt: r.createdAt,
    })) };
  }

  /**
   * The ONLY write path. Manual by construction (route = operator+ session);
   * illegal transitions 409 fail-closed. `evidence` = free-form operator note
   * (single string, scrubbed, length-capped, credential-shaped keys rejected).
   */
  async function transition(identityId, to, { actorUserId, evidence, requestId, ip } = {}) {
    if (!LOGIN_STATES.includes(to)) {
      fail('VALIDATION_ERROR', 400, `unknown login state '${to}' (allowed: ${LOGIN_STATES.join('|')})`);
    }
    const evidenceJson = {};
    if (evidence !== undefined && evidence !== null && evidence !== '') {
      if (typeof evidence !== 'string') fail('VALIDATION_ERROR', 400, 'evidence must be a short operator note (string)');
      const note = String(evidence).slice(0, EVIDENCE_NOTE_MAX);
      if (CREDENTIAL_KEY.test(note)) {
        fail('VALIDATION_ERROR', 400, 'evidence must not contain credential-shaped values (password/token/cookie/secret/otp)');
      }
      evidenceJson.note = note;
    }

    const ident = await db.identity.findUnique({ where: { id: identityId } });
    if (!ident) fail('IDENTITY_NOT_FOUND', 404, `identity '${identityId}' not found`);
    const from = ident.loginState ?? 'PENDING_LOGIN';
    if (!isLegalLoginTransition(from, to)) {
      fail('INVALID_LOGIN_TRANSITION', 409,
        `login transition ${from} → ${to} is not allowed (allowed from ${from}: ${LOGIN_TRANSITIONS[from]?.join(', ') ?? 'none'}; self-transitions are rejected — a repeat click is a bug, not a no-op)`);
    }

    const now = new Date();
    await db.identity.update({ where: { id: identityId }, data: { loginState: to, loginStateSince: now } });
    const row = await db.identityLoginAudit.create({
      data: {
        id: randomUUID(),
        identityId,
        fromState: from,
        toState: to,
        actorUserId: actorUserId ?? null,
        evidenceJson,
        createdAt: now,
      },
    });
    if (audit) {
      await audit({
        actorUserId: actorUserId ?? null,
        action: 'identity.login.transition',
        resourceType: 'identity',
        resourceId: identityId,
        requestId: requestId ?? null,
        ip: ip ?? null,
        status: 'success',
        details: { from, to },
      }).catch((err) => log.warn?.({ error: err?.message }, 'login-state: audit write failed'));
    }
    return { identityId, loginState: to, loginStateSince: now, auditId: row.id };
  }

  return { getLoginState, listAudit, transition, __states: LOGIN_STATES, __matrix: LOGIN_TRANSITIONS };
}
