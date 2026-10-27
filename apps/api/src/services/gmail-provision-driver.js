/**
 * T5 (ADR-030) — Gmail account-creation driver (code segment: service layer
 * + mock device adapter; the real-device segment swaps in the W2
 * uiautomator-probe adapter behind THE SAME interface).
 *
 * The UI flow step machine (Gmail App signup):
 *   open-signup → fill-profile → captcha-gate (HUMAN, never auto-solved:
 *   an EXTERNAL_VERIFICATION intervention ticket is opened and the run
 *   PAUSES in AWAITING_HUMAN) → [operator resolves ticket] → resume →
 *   detect-created → vault credentials → recovery-email (fail-closed: no
 *   recovery pool ⇒ can never reach READY) → READY.
 *
 * Throttle (per identity / per egress IP daily counters + randomized global
 * minimum interval) is checked BEFORE any state moves, and only a FRESH
 * start consumes quota (resume is free).
 *
 * Device adapter interface (real segment implements via W2 uiautomator):
 *   openSignupForm(ref)                       throws → step failure
 *   fillProfile(ref, profile)                 profile = deriveAccountProfile()
 *   awaitCaptcha(ref)                         resolves once the captcha page shows
 *   detectAccountCreated(ref, {gateCleared})  → {email} | null
 *   setRecoveryEmail(ref, recoveryEmail)      → {ok:true}
 * ref = identity device name (externalRef) — the mock keys on it.
 *
 * Zero secrets (canary-tested): plaintext email/password/recovery address
 * flow ONLY adapter→vault (AES-256-GCM). Logs/audits/responses carry masked
 * shapes and reason codes.
 */
import crypto from 'node:crypto';

import {
  INTERVENTION_CATEGORY,
  INTERVENTION_SOURCE,
  INTERVENTION_SEVERITY,
  INTERVENTION_STATUS,
  AUTOMATION_DISPOSITION,
  createInterventionSignalWriter,
  encryptSecret,
  resolveProviderKey,
  deriveAccountProfile,
  maskEmail,
  dayKey,
  evaluateThrottle,
  throttleScopeKeys,
  pickRecoveryEmail,
} from '@water-army/shared';

function fail(code, status, message, details) {
  const err = new Error(message);
  err.apiCode = code;
  err.httpStatus = status;
  err.statusCode = status;
  if (details) err.details = details;
  throw err;
}

function generatePassword() {
  // 12 base64url chars + forced classes — shape-compatible with Google's
  // minimum (8+, mixed case + digit); symbol keeps autofill honest.
  return `${crypto.randomBytes(9).toString('base64url')}aA1!`;
}

// ---------------------------------------------------------------------------
// Mock device adapter (deterministic; simulates the Gmail signup UI states)
// ---------------------------------------------------------------------------

export function createGmailDeviceAdapterFake({ emailDomain = 'gmail.com' } = {}) {
  const state = new Map(); // ref → { captchaSeen, created, email, recoverySet }
  const s = (ref) => {
    if (!state.has(ref)) state.set(ref, { captchaSeen: false, created: false, recoverySet: false });
    return state.get(ref);
  };
  return {
    __state: state,
    async openSignupForm(ref) { s(ref); },
    async fillProfile(ref, profile) {
      if (!profile || typeof profile.givenName !== 'string') throw new Error('fillProfile: profile required');
    },
    async awaitCaptcha(ref) {
      s(ref).captchaSeen = true;
      return { captchaVisible: true };
    },
    async detectAccountCreated(ref, { gateCleared } = {}) {
      const st = s(ref);
      if (!st.captchaSeen || !gateCleared) return null;
      if (!st.email) {
        // fake address (the REAL flow's address is chosen by Google and read
        // back; the uniqueness loop lives in the real adapter).
        st.email = `acct.${crypto.createHash('sha1').update(ref).digest('hex').slice(0, 10)}@${emailDomain}`;
      }
      return { email: st.email };
    },
    async setRecoveryEmail(ref, recoveryEmail) {
      if (typeof recoveryEmail !== 'string' || !recoveryEmail.includes('@')) throw new Error('setRecoveryEmail: address required');
      s(ref).recoverySet = true;
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.config gmail* knobs + encryptionKey
 * @param {object} deps.lifecycleService createAccountLifecycleService instance
 * @param {object} [deps.adapter] device adapter (defaults to the fake)
 * @param {object} [deps.log]
 * @param {() => Date} [deps.now] injectable clock (timeout tests)
 * @param {() => number} [deps.rand] injectable jitter
 * @param {Function} [deps.audit]
 */
export function createGmailProvisionDriver({
  db, config, lifecycleService, adapter = createGmailDeviceAdapterFake(),
  log = { info() {}, warn() {}, error() {} }, now = () => new Date(), rand = Math.random, audit = null,
} = {}) {
  if (!db?.accountLifecycle) throw new TypeError('createGmailProvisionDriver: db.accountLifecycle required');
  const signalWriter = createInterventionSignalWriter({ db, log, audit, now });
  const vaultKey = () => resolveProviderKey(config.encryptionKey);

  async function getVault(identityId) {
    return db.gmailAccount.findUnique({ where: { identityId } });
  }
  async function upsertVault(identityId, data) {
    const existing = await getVault(identityId);
    if (existing) return db.gmailAccount.update({ where: { identityId }, data });
    return db.gmailAccount.create({ data: { id: crypto.randomUUID(), identityId, ...data } });
  }

  async function egressIpOf(identityId) {
    if (!db.identityEgress) return null;
    const row = await db.identityEgress.findUnique({ where: { identityId } });
    return row?.expectedEgressIp ?? null;
  }

  async function counterRow(scopeKey, day) {
    return db.gmailProvisionCounter.findUnique({ where: { scopeKey_day: { scopeKey, day } } });
  }

  async function loadCounters(identityId, ip) {
    const day = dayKey(now());
    const counters = new Map();
    for (const key of throttleScopeKeys(identityId, ip)) {
      const row = await counterRow(key, day);
      counters.set(key, row ?? { count: 0 });
    }
    const g = await counterRow('global', '-');
    return { counters, lastStartedAt: g?.lastStartedAt ?? null };
  }

  async function bumpCounters(identityId, ip) {
    const day = dayKey(now());
    const t = now();
    for (const key of throttleScopeKeys(identityId, ip)) {
      const row = await counterRow(key, day);
      if (row) await db.gmailProvisionCounter.update({ where: { id: row.id }, data: { count: { increment: 1 }, lastStartedAt: t } });
      else await db.gmailProvisionCounter.create({ data: { id: crypto.randomUUID(), scopeKey: key, day, count: 1, lastStartedAt: t } });
    }
    const g = await counterRow('global', '-');
    if (g) await db.gmailProvisionCounter.update({ where: { id: g.id }, data: { lastStartedAt: t } });
    else await db.gmailProvisionCounter.create({ data: { id: crypto.randomUUID(), scopeKey: 'global', day: '-', count: 0, lastStartedAt: t } });
  }

  /** Open (or re-escalate) the CAPTCHA intervention ticket (P4 mechanism). */
  async function openCaptchaTicket(identityId, deviceRef) {
    let deviceId = null;
    if (db.device?.findFirst) {
      const dev = await db.device.findFirst({ where: { identityId } });
      deviceId = dev?.id ?? null;
    }
    const res = await signalWriter.recordSignal({
      deviceId,
      deviceNameSnapshot: deviceRef,
      source: INTERVENTION_SOURCE.EXTERNAL_VERIFICATION,
      category: INTERVENTION_CATEGORY.EXTERNAL_VERIFICATION,
      severity: INTERVENTION_SEVERITY.HIGH,
      title: `Gmail signup CAPTCHA gate — ${deviceRef}`,
      summary: 'Account creation paused at the human verification gate. No auto-solve (ADR-030): resolve this ticket after completing the captcha on the device, then resume provisioning.',
      automationDisposition: AUTOMATION_DISPOSITION.BLOCKED_PENDING_REVIEW,
    });
    if (!res?.intervention) fail('INTERVENTION_UNAVAILABLE', 503, 'cannot open the CAPTCHA intervention ticket — provisioning stays unpaused');
    return res.intervention;
  }

  /** Recovery pool — fail-closed everywhere the pipeline needs one. */
  function recoveryFor(identityId) {
    return pickRecoveryEmail(identityId, config?.gmailRecoveryPool ?? []);
  }

  /**
   * Advance one identity's provisioning by ONE driver touch.
   * Fresh (PREPARING) → runs until the captcha gate. Resume while
   * AWAITING_HUMAN → proceeds only if the intervention is resolved; a
   * deadline breach with the ticket still open marks the account DEAD.
   */
  async function provisionOne(identityId, { actorUserId = null, requestId, ip } = {}) {
    const actor = { actorUserId, requestId, ip };
    const ident = await db.identity.findUnique({ where: { id: identityId } });
    if (!ident) fail('IDENTITY_NOT_FOUND', 404, `identity '${identityId}' not found`);
    const lc = await lifecycleService.ensure(identityId);
    const deviceRef = ident.externalRef ?? ident.displayName;
    if (lc.state === 'READY') fail('ACCOUNT_ALREADY_READY', 409, `identity ${identityId} account is already READY`);
    if (lc.state === 'DEAD') fail('ACCOUNT_DEAD', 409, `identity ${identityId} account is DEAD (${lc.failureCode ?? 'unknown'}) — provision a new identity`, { failureCode: lc.failureCode ?? null });

    // Fail-closed input gate BEFORE consuming quota: no recovery pool = the
    // account can never be allowed into 就緒, so don't even burn a signup.
    const recovery = recoveryFor(identityId);
    if (!recovery) {
      fail('ACCOUNT_INPUT_MISSING', 503, 'GMAIL_RECOVERY_POOL is empty — provisioning is fail-closed (no recovery mailbox = no READY account; ADR-030)');
    }

    let resumedFromGate = false;

    if (lc.state === 'PREPARING') {
      // ---- throttle only gates FRESH starts (resume is free) --------------
      const eip = await egressIpOf(identityId);
      const { counters, lastStartedAt } = await loadCounters(identityId, eip);
      const verdict = evaluateThrottle({
        perIpDaily: config.gmailPerIpDaily,
        perIdentityDaily: config.gmailPerIdentityDaily,
        minIntervalMs: config.gmailMinIntervalMs,
        maxIntervalMs: config.gmailMaxIntervalMs,
        ip: eip, identityId, counters, lastStartedAt, now: now(), rand,
      });
      if (!verdict.ok) fail(verdict.code, 429, `provisioning throttled (${verdict.code})`, { retryAfterMs: verdict.retryAfterMs ?? null });
      await bumpCounters(identityId, eip);
      await lifecycleService.transition(identityId, 'PROVISIONING', { ...actor, reasonCode: 'DRIVER_START' });
    } else if (lc.state === 'AWAITING_HUMAN') {
      // ---- human gate: proceed only on a RESOLVED/DISMISSED ticket --------
      const ticket = lc.interventionId ? await db.manualIntervention.findUnique({ where: { id: lc.interventionId } }) : null;
      const cleared = ticket && (ticket.status === INTERVENTION_STATUS.RESOLVED || ticket.status === INTERVENTION_STATUS.DISMISSED);
      if (!cleared) {
        const deadline = lc.awaitingDeadlineAt ? new Date(lc.awaitingDeadlineAt) : null;
        if (deadline && now() > deadline) {
          await lifecycleService.transition(identityId, 'DEAD', {
            ...actor, reasonCode: 'CAPTCHA_TIMEOUT',
            set: { failureCode: 'CAPTCHA_TIMEOUT', interventionId: null, awaitingDeadlineAt: null },
          });
          return { state: 'DEAD', failureCode: 'CAPTCHA_TIMEOUT', identityId };
        }
        fail('AWAITING_HUMAN', 409, 'account creation is paused at the human verification gate — resolve the intervention ticket first', { interventionId: lc.interventionId });
      }
      await lifecycleService.transition(identityId, 'PROVISIONING', {
        ...actor, reasonCode: 'HUMAN_GATE_CLEARED',
        set: { interventionId: null, awaitingDeadlineAt: null },
      });
      resumedFromGate = true;
    }

    // ---- PROVISIONING steps ------------------------------------------------
    const vaultProfile = await getVault(identityId);
    const profile = vaultProfile?.profileJson?.givenName
      ? vaultProfile.profileJson
      : deriveAccountProfile(String(identityId));
    if (!vaultProfile) await upsertVault(identityId, { profileJson: profile });

    try {
      if (!resumedFromGate) {
        // Fresh run: drive the signup UI up to the CAPTCHA gate, open the
        // human ticket, and PAUSE there (never auto-solve — ADR-030).
        await lifecycleService.setStep(identityId, 'open-signup');
        await adapter.openSignupForm(deviceRef);
        await lifecycleService.setStep(identityId, 'fill-profile');
        await adapter.fillProfile(deviceRef, profile);
        await lifecycleService.setStep(identityId, 'captcha-gate');
        await adapter.awaitCaptcha(deviceRef);
        const ticket = await openCaptchaTicket(identityId, deviceRef);
        const deadline = new Date(now().getTime() + config.gmailCaptchaTimeoutMs);
        const res = await lifecycleService.transition(identityId, 'AWAITING_HUMAN', {
          ...actor, reasonCode: 'CAPTCHA_GATE',
          set: { currentStep: 'captcha-gate', interventionId: ticket.id, awaitingDeadlineAt: deadline },
        });
        return { state: 'AWAITING_HUMAN', interventionId: ticket.id, awaitingDeadlineAt: deadline, auditId: res.auditId, identityId };
      }

      // Gate cleared (resume path): read the created account back, vault it.
      const created = await adapter.detectAccountCreated(deviceRef, { gateCleared: true });
      if (!created?.email) fail('ACCOUNT_NOT_DETECTED', 409, 'human gate cleared but the created account is not visible yet — retry after the app settles');
      await lifecycleService.setStep(identityId, 'vault-credentials');
      const password = generatePassword();
      await upsertVault(identityId, {
        emailMasked: maskEmail(created.email),
        emailCipher: encryptSecret(created.email, vaultKey()),
        passwordCipher: encryptSecret(password, vaultKey()),
      });
      await lifecycleService.transition(identityId, 'CREATED', { ...actor, reasonCode: 'ACCOUNT_CREATED', set: { currentStep: 'recovery-setup' } });
      await lifecycleService.transition(identityId, 'RECOVERY_SETUP', { ...actor, reasonCode: 'RECOVERY_START' });

      // Recovery email (re-pick: pool may have changed between the touches).
      const rec = recoveryFor(identityId);
      if (!rec) fail('ACCOUNT_INPUT_MISSING', 503, 'recovery pool emptied mid-flow — account stays in RECOVERY_SETUP (can never enter READY fail-closed)');
      await adapter.setRecoveryEmail(deviceRef, rec);
      await upsertVault(identityId, {
        recoveryEmailCipher: encryptSecret(rec, vaultKey()),
        recoveryEmailMasked: maskEmail(rec),
      });
      const res = await lifecycleService.transition(identityId, 'READY', { ...actor, reasonCode: 'RECOVERY_CONFIGURED', set: { currentStep: 'done' } });
      log.info?.({ identityId, email: maskEmail(created.email), recovery: maskEmail(rec) }, 'gmail provision: account READY');
      return { state: 'READY', identityId, emailMasked: maskEmail(created.email), recoveryEmailMasked: maskEmail(rec), auditId: res.auditId };
    } catch (e) {
      if (e?.apiCode && e.statusCode && e.statusCode < 500) throw e; // caller-facing verdicts keep their shape
      // Adapter/hard failure → DEAD (the pipeline does not retry a partial
      // signup: a half-created Google account is exactly the correlation risk).
      const code = 'ADAPTER_FAILURE';
      await lifecycleService.transition(identityId, 'DEAD', {
        ...actor, reasonCode: code,
        set: { failureCode: code, interventionId: null, awaitingDeadlineAt: null },
      }).catch(() => {});
      log.error?.({ identityId, error: e?.message }, 'gmail provision: adapter failure → DEAD');
      fail('GMAIL_PROVISION_STEP_FAILED', 502, `provisioning step failed (${e?.message ?? 'adapter error'}) — account marked DEAD`, { step: lc.currentStep ?? null });
    }
  }

  return { provisionOne };
}
