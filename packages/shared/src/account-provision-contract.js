/**
 * Account Generator (ADR-034 §6) — registration-automation driver CONTRACT.
 *
 * This ticket defines the contract + a deterministic stub ONLY; the Chrome
 * automation implementation is the NEXT ticket and must plug into exactly
 * this surface. Shape mirrors the proven T5 pattern (adapter interface +
 * lifecycle transition events) but sits one level up: inputs are the
 * generated persona + its credentials; outputs are the audited lifecycle
 * state-machine events (ACCOUNT_STATES, gmail-provision.js) plus human-gate
 * escalations.
 *
 * HARD RULES encoded by the validators (fail-closed, unit-tested):
 *  1. Human gates (SMS verification wall / CAPTCHA / TOS) route to the
 *     EXISTING intervention console machinery — category
 *     `EXTERNAL_VERIFICATION` (ADR-021 dedupe, ADR-030 captcha gate
 *     precedent). AUTO-SOLVE IS FORBIDDEN: an event claiming
 *     `{gateCleared:'auto'}` or an `AUTO_SOLVED`-style event kind is a
 *     contract violation, not a warning.
 *  2. Every STATE_TRANSITION target must be a legal next state per the T5
 *     matrix (`isLegalAccountTransition`) — the driver cannot invent states.
 *  3. Input credentials are transient: `validateProvisionInput` checks the
 *     SHAPE only; implementations must never echo credential fields into
 *     events (the validator rejects event payloads carrying `password`).
 */
import { ACCOUNT_STATES, isLegalAccountTransition } from './gmail-provision.js';

export const PROVISION_CONTRACT_VERSION = 1;

/** Event kinds the driver may emit (closed set — anything else is invalid). */
export const PROVISION_EVENT_KINDS = Object.freeze([
  'STATE_TRANSITION', // {to, reasonCode?} — T5 matrix-checked
  'STEP_PROGRESS',    // {step: slug} — driver bookkeeping, no state change
  'HUMAN_GATE',       // {gate, interventionCategory, reasonCode?} — pauses the run
  'CREDENTIALS_SEALED', // credentials written to the vault (pointer, never values)
  'TERMINAL_FAILURE', // {failureCode} — expected to be followed by STATE_TRANSITION →DEAD
]);

/** Human-gate types (the SMS wall and CAPTCHA are BOTH human-only). */
export const PROVISION_GATES = Object.freeze(['CAPTCHA', 'SMS_VERIFICATION', 'TOS_CONFIRMATION', 'RECOVERY_SETUP']);

/** The ONLY intervention category a gate may escalate to (console reuses ADR-021). */
export const PROVISION_GATE_INTERVENTION_CATEGORY = 'EXTERNAL_VERIFICATION';

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

/**
 * Validate a driver input: {persona, credentials:{email,password}, refs}.
 * Shape-only (no policy re-check — persona already validated upstream).
 * @returns {string[]} problems
 */
export function validateProvisionInput(input) {
  const problems = [];
  if (!input || typeof input !== 'object') return ['provision input must be a plain object'];
  const i = input;
  if (!i.persona || typeof i.persona !== 'object' || typeof i.persona.accountId !== 'string') {
    problems.push('input.persona (with accountId) required');
  } else if (typeof i.persona.role !== 'string') {
    problems.push('input.persona.role required');
  }
  if (!i.credentials || typeof i.credentials !== 'object') problems.push('input.credentials {email,password} required');
  else {
    if (typeof i.credentials.email !== 'string' || !i.credentials.email.includes('@')) problems.push('credentials.email must be an address');
    if (typeof i.credentials.password !== 'string' || i.credentials.password.length < 8) problems.push('credentials.password must be a non-trivial string');
  }
  if (i.refs !== undefined) {
    if (!i.refs || typeof i.refs !== 'object') problems.push('input.refs must be an object when present');
    else if (i.refs.identityId !== undefined && typeof i.refs.identityId !== 'string') problems.push('refs.identityId must be a string');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Event contract
// ---------------------------------------------------------------------------

/**
 * Validate one emitted event. `fromState` is the driver's view of the current
 * lifecycle state (STATE_TRANSITION events are matrix-checked against it).
 * @returns {string[]} problems
 */
export function validateProvisionEvent(event, { fromState = null } = {}) {
  const problems = [];
  if (!event || typeof event !== 'object') return ['event must be a plain object'];
  const e = event;
  if (!PROVISION_EVENT_KINDS.includes(e.kind)) {
    problems.push(`event.kind '${e.kind}' not in closed set (${PROVISION_EVENT_KINDS.join('|')}) — AUTO_SOLVE kinds are contract violations by design`);
    return problems;
  }
  // zero-secrets: no credential-shaped payload anywhere on an event
  for (const key of Object.keys(e)) {
    if (/password|secret|token/i.test(key)) problems.push(`event field '${key}' carries a credential shape — events are secret-free`);
  }
  if (e.kind === 'STATE_TRANSITION') {
    if (!ACCOUNT_STATES.includes(e.to)) problems.push(`STATE_TRANSITION target '${e.to}' is not an ACCOUNT_STATE`);
    else if (fromState && !isLegalAccountTransition(fromState, e.to)) {
      problems.push(`STATE_TRANSITION ${fromState} → ${e.to} violates the T5 matrix (authoritative: gmail-provision.js)`);
    }
    if (e.reasonCode !== undefined && !/^[A-Z0-9_]{2,60}$/.test(e.reasonCode)) problems.push('reasonCode must be a scrubbed slug ^[A-Z0-9_]{2,60}$');
  } else if (e.kind === 'STEP_PROGRESS') {
    if (typeof e.step !== 'string' || !/^[a-z0-9-]{2,60}$/.test(e.step)) problems.push('step must be an opaque slug');
  } else if (e.kind === 'HUMAN_GATE') {
    if (!PROVISION_GATES.includes(e.gate)) problems.push(`gate '${e.gate}' not in ${PROVISION_GATES.join('|')}`);
    if (e.interventionCategory !== PROVISION_GATE_INTERVENTION_CATEGORY) {
      problems.push(`HUMAN_GATE must escalate to interventionCategory '${PROVISION_GATE_INTERVENTION_CATEGORY}' (console machinery reuse)`);
    }
    // AUTO-SOLVE FORBIDDEN: the only legal clears come from the ticket
    // RESOLVED/DISMISSED path (human). 'auto' here is a contract violation.
    if (e.gateCleared === 'auto') problems.push('gateCleared:auto is forbidden — SMS/CAPTCHA are human-only (ADR-030 拍板)');
  } else if (e.kind === 'CREDENTIALS_SEALED') {
    if (typeof e.vaultRef !== 'string' || e.vaultRef === '') problems.push('CREDENTIALS_SEALED must carry vaultRef (pointer only)');
  } else if (e.kind === 'TERMINAL_FAILURE') {
    if (typeof e.failureCode !== 'string' || !/^[A-Z0-9_]{2,60}$/.test(e.failureCode)) problems.push('TERMINAL_FAILURE requires failureCode (loss-rate discipline, ADR-030)');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Stub driver (deterministic; proves the contract end-to-end)
// ---------------------------------------------------------------------------

/**
 * Contract stub: emits the canonical opening sequence for one account and
 * parks at the human gate — exactly where the real Chrome driver will pause.
 * Interface the next ticket must implement:
 *   drive(input, ctx) → async generator of events (caller matrix-validates
 *   each, tracks fromState, and writes transitions via
 *   account-lifecycle-service — the driver NEVER touches the DB directly).
 */
export function createProvisionDriverStub({ gate = 'CAPTCHA' } = {}) {
  return {
    name: 'provision-stub',
    contractVersion: PROVISION_CONTRACT_VERSION,
    async *drive(input) {
      const problems = validateProvisionInput(input);
      if (problems.length) throw new Error(`provision-stub: invalid input: ${problems.join('; ')}`);
      yield { kind: 'STATE_TRANSITION', to: 'PROVISIONING', reasonCode: 'STUB_START' };
      yield { kind: 'STEP_PROGRESS', step: 'open-signup-form' };
      yield { kind: 'STEP_PROGRESS', step: 'fill-profile' };
      yield { kind: 'HUMAN_GATE', gate, interventionCategory: PROVISION_GATE_INTERVENTION_CATEGORY, reasonCode: 'STUB_HUMAN_GATE' };
    },
  };
}

/** Consume a stub run for tests/tooling; returns {events, problems}. */
export async function runProvisionStub(driver, input, { fromState = 'PREPARING' } = {}) {
  const events = [];
  const problems = [];
  let state = fromState;
  for await (const ev of driver.drive(input)) {
    problems.push(...validateProvisionEvent(ev, { fromState: state }));
    if (ev.kind === 'STATE_TRANSITION') state = ev.to;
    events.push(ev);
  }
  return { events, problems, endState: state };
}
