/**
 * GAcct 段4 — Google account CREATION flow as a declarative STEP TABLE +
 * deterministic driver (implements the ADR-034 §5 provision contract on the
 * device side, alongside the generic createProvisionDriverStub).
 *
 * The step table mechanises the CEO's real-device walkthrough (2026-10-28,
 * logs/waterarmy-whitelist-gmail-progress.md attendance checklist):
 *   MinuteMaid (GMS) Create-account: name → birthday → gender → custom
 *   (gmail) name → password → phone [SKIP] → recovery email [leave empty]
 *   → TOS [tick ×2 + confirm]. Zero-SMS is viable (phone skipped).
 *
 * HARD RULES encoded here:
 *  1. Skip-type links use the MICRO SWIPE gesture (`input swipe x y x y-1
 *     120`) — plain taps get eaten by the soft keyboard (WebView gotcha ①).
 *  2. The flow NEVER presses KEYCODE_BACK: one press walks back multiple
 *     WebView steps (gotcha ③); a stuck run halts loudly instead.
 *  3. uiautomator cannot read MinuteMaid/uncertified WebViews (gotcha ②),
 *     so per-step evidence is a screencap PNG, and page classification is
 *     delegated to an injected `classify(buffer, step)` hook (OCR/vision or
 *     an operator reading the evidence). The driver NEVER claims to see text.
 *  4. Human gates (CAPTCHA / risk-control / unexpected page) → HUMAN_GATE
 *     event (category EXTERNAL_VERIFICATION — AUTO-SOLVE is a contract
 *     violation) + a `blocked_pending_review` handoff FILE (MC intervention
 *     console concept; file handoff is sufficient for this segment).
 *  5. Events are secret-free: passwords are typed via adb but never appear
 *     in events or the handoff file (validateProvisionEvent's zero-credential
 *     rule applies; the step table references credentials by FIELD name).
 *
 * Coordinates are calibrated at 720x1280 (CEO session) and scaled by the
 * driver to the device's reported size.
 */
import { validateProvisionInput, validateProvisionEvent, PROVISION_GATE_INTERVENTION_CATEGORY } from './account-provision-contract.js';

export const SIGNUP_STEPS_VERSION = 1;
/** Coordinate baseline of every `at` below (real device was 720x1280). */
export const SIGNUP_COORD_BASE = Object.freeze({ w: 720, h: 1280 });

/** Field names the driver may type (password stays out of events/evidence). */
export const SIGNUP_FIELDS = Object.freeze(['givenName', 'familyName', 'month', 'day', 'year', 'gender', 'username', 'password', 'confirmPassword']);

const GENDER_FIELD_BY_VALUE = Object.freeze({ M: 'male', F: 'female' });

/**
 * The canonical field-first step table. `at` = [x, y] at SIGNUP_COORD_BASE
 * (from the CEO walkthrough; TUNE per step against evidence PNGs before
 * unattended fleet runs — honest limitation, recorded in ADR-034 §7).
 * Action kinds: tap | micro-swipe | type | key.
 * `expect` is advisory for classify(): the page the step should land on.
 */
export const CREATE_ACCOUNT_STEPS = Object.freeze([
  { id: 'entry-create-account', action: { kind: 'tap', at: [360, 640] }, expect: 'create-account-menu', note: 'MinuteMaid sign-in page → "Create account" (menu position varies with keyboard state)' },
  { id: 'entry-for-myself', action: { kind: 'tap', at: [280, 545] }, expect: 'name-page', note: '"For my personal use"' },
  { id: 'fill-name', fields: ['familyName', 'givenName'], action: { kind: 'type', at: [360, 430] }, expect: 'birthday-page', next: 'fill-birthday', retries: 1 },
  { id: 'fill-birthday', fields: ['month', 'day', 'year'], action: { kind: 'type', at: [360, 520] }, expect: 'gender-page', next: 'fill-gender', retries: 1 },
  { id: 'fill-gender', action: { kind: 'tap', at: [360, 610] }, genderChoice: true, expect: 'username-page', next: 'fill-username', retries: 1, note: 'gender page coordinates depend on the chosen value (genderField)' },
  { id: 'fill-username', fields: ['username'], action: { kind: 'type', at: [360, 470] }, expect: 'username-taken-or-password', next: 'fill-password', retries: 2, note: 'retry = gmail prefix taken → caller feeds a new candidate (username field refill)' },
  { id: 'fill-password', fields: ['password', 'confirmPassword'], action: { kind: 'type', at: [360, 470] }, expect: 'phone-page', next: 'skip-phone', retries: 1 },
  // HARD DISCIPLINE: phone step is SKIPPED (zero-SMS). The Skip link is a JS
  // anchor inside a WebView with the keyboard up — plain tap is EATEN
  // (gotcha ①); the 1px micro swipe fires the click without keyboard steal.
  { id: 'skip-phone', action: { kind: 'micro-swipe', at: [640, 1150] }, expect: 'recovery-page', next: 'recovery-empty', hardDiscipline: 'phone-skip-zero-sms' },
  // Recovery email intentionally left EMPTY (CEO flow: [空]) → just continue.
  { id: 'recovery-empty', action: { kind: 'tap', at: [630, 1206] }, expect: 'tos-page', next: 'tos-tick-1' },
  { id: 'tos-tick-1', action: { kind: 'tap', at: [50, 1100] }, expect: 'tos-page', next: 'tos-tick-2' },
  { id: 'tos-tick-2', action: { kind: 'tap', at: [50, 1140] }, expect: 'tos-page', next: 'tos-confirm' },
  { id: 'tos-confirm', action: { kind: 'tap', at: [630, 1206] }, expect: 'inbox-or-gate', next: null },
]);

/** Step whose completion means the automated segment is done (CREATED). */
export const SIGNUP_COMPLETION_STEP = 'tos-confirm';

/**
 * Deterministic candidate values for a persona (NO randomness: derived from
 * the persona + accountId stream so a replayed run types the same inputs).
 * @param {object} persona validated persona (generatePersona output)
 * @returns {Record<string,string>} field → value (SIGNUP_FIELDS subset)
 */
export function deriveSignupValues(persona) {
  const [y, m, d] = String(persona.birthday).split('-').map(Number);
  const genderValue = typeof persona.gender === 'string' ? persona.gender
    : (persona.hk && persona.hk.gender) ? persona.hk.gender : null;
  return {
    givenName: persona.name.givenName,
    familyName: persona.name.familyName,
    month: String(m), day: String(d), year: String(y),
    gender: genderValue,
    genderField: genderValue ? (GENDER_FIELD_BY_VALUE[genderValue] ?? null) : null,
    username: persona.gmail.prefix,
    password: persona.password,
    confirmPassword: persona.password,
  };
}

/**
 * Resolve the concrete adb action for one step (scales coords, resolves the
 * gender choice, substitutes field values). Pure.
 * @returns {{cmd:string[], note?:string}|null} null = nothing to run
 */
export function resolveStepAction(step, { screen = SIGNUP_COORD_BASE, values = {} } = {}) {
  const a = step.action;
  const sx = (x) => Math.max(0, Math.round(x * screen.w / SIGNUP_COORD_BASE.w));
  const sy = (y) => Math.max(0, Math.round(y * screen.h / SIGNUP_COORD_BASE.h));
  if (a.kind === 'tap') return { cmd: ['input', 'tap', String(sx(a.at[0])), String(sy(a.at[1]))] };
  if (a.kind === 'micro-swipe') {
    const x = sx(a.at[0]); const y = sy(a.at[1]);
    return { cmd: ['input', 'swipe', String(x), String(y), String(x), String(y - 1), '120'] };
  }
  if (a.kind === 'key') return { cmd: ['input', 'keyevent', String(a.key)] };
  if (a.kind === 'type') {
    const taps = [];
    for (const f of step.fields ?? []) {
      const v = values[f];
      if (v === undefined || v === null || v === '') continue;
      taps.push({ cmd: ['input', 'tap', String(sx(a.at[0])), String(sy(a.at[1]))] });
      taps.push({ cmd: ['input', 'text', String(v)] });
    }
    return taps.length ? { cmd: taps[0].cmd, expansions: taps } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Build the create-account driver. Interface (contract-compatible):
 *   drive(input, { resumeFromStep?, gateCleared? }) → async event stream.
 * `resumeFromStep` restarts the table AFTER a named step (human cleared a
 * gate on-device; caller passes the step the gate was raised on).
 *
 * ctx (injected at construction — hermetic tests inject fakes):
 *  - runAdb(args: string[]) → Promise<string>  (adb -s <serial> shell argv)
 *  - screencap()          → Promise<Buffer>
 *  - screen               → {w, h} (default 720x1280 baseline)
 *  - classify(buffer, step) → Promise<'ok'|'captcha'|'risk'|'unexpected'|null>|... (default null)
 *  - writeEvidence(name, buffer) → Promise<void> (per-step screencap retention)
 *  - handoff(record)      → Promise<string> handoff file path (blocked_pending_review)
 *  - sleep(ms)            → Promise (default real timer; tests inject 0)
 */
export function createSignupDriver(ctx = {}) {
  const {
    runAdb, screencap, screen = SIGNUP_COORD_BASE,
    classify = () => null, writeEvidence = () => {}, handoff = () => '',
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    stepWaitMs = 800,
  } = ctx;
  if (typeof runAdb !== 'function' || typeof screencap !== 'function') {
    throw new TypeError('createSignupDriver: ctx.runAdb and ctx.screencap are required');
  }

  async function* validated(ev, fromState) {
    const problems = validateProvisionEvent(ev, { fromState });
    if (problems.length) throw new Error(`signup-driver: contract violation: ${problems.join('; ')}`);
    yield ev;
  }

  return {
    name: 'signup-minutemaid',
    contractVersion: 1,
    stepsVersion: SIGNUP_STEPS_VERSION,
    /** @param {{persona:object, credentials:{email:string,password:string}, refs?:object}} input */
    async *drive(input, { resumeFromStep = null } = {}) {
      const problems = validateProvisionInput(input);
      if (problems.length) throw new Error(`signup-driver: invalid input: ${problems.join('; ')}`);
      const values = deriveSignupValues(input.persona);
      let state = 'PREPARING';
      const started = Date.now();

      // Credentials are already vaulted (registry created the record) —
      // seal confirmation is emitted up-front as a pointer-only event.
      yield* validated({ kind: 'CREDENTIALS_SEALED', vaultRef: `vault:${input.persona.accountId}` }, state);
      yield* validated({ kind: 'STATE_TRANSITION', to: 'PROVISIONING', reasonCode: 'SIGNUP_START' }, state);
      state = 'PROVISIONING';

      const startIdx = resumeFromStep
        ? CREATE_ACCOUNT_STEPS.findIndex((s) => s.id === resumeFromStep) + 1
        : 0;
      if (resumeFromStep && startIdx === 0) throw new Error(`signup-driver: unknown resumeFromStep '${resumeFromStep}'`);

      for (let i = startIdx; i < CREATE_ACCOUNT_STEPS.length; i++) {
        const step = CREATE_ACCOUNT_STEPS[i];
        const attemptMax = 1 + (step.retries ?? 0);
        let done = false;
        for (let attempt = 0; attempt < attemptMax && !done; attempt++) {
          // 1. execute the mechanical actions
          if (step.genderChoice && values.genderField) {
            // gender tap coordinate follows the chosen field's nominal row
            const gstep = { ...step, action: { ...step.action, at: values.genderField === 'male' ? [360, 560] : [360, 640] } };
            const r = resolveStepAction(gstep, { screen, values });
            if (r) await runAdb(r.cmd);
          } else if (step.action.kind === 'type') {
            const r = resolveStepAction(step, { screen, values });
            if (r) for (const t of (r.expansions ?? [r])) await runAdb(t.cmd);
          } else {
            const r = resolveStepAction(step, { screen, values });
            if (r) await runAdb(r.cmd);
          }
          await sleep(stepWaitMs);

          // 2. evidence (screencap per step — the ONLY reliable UI read)
          const shot = await screencap();
          await writeEvidence(`${String(i).padStart(2, '0')}-${step.id}.png`, shot);

          // 3. classify (injected; default blind → 'ok' continues the table)
          const verdict = await classify(shot, step);
          if (verdict === 'captcha' || verdict === 'risk' || verdict === 'unexpected') {
            // Gate mapping (operational convention, closed PROVISION_GATES set):
            //  captcha → CAPTCHA; risk-control wall → SMS_VERIFICATION (its
            //  classic manifestation is a phone-verification demand);
            //  unexpected page → TOS_CONFIRMATION (needs human eyes).
            const gate = verdict === 'captcha' ? 'CAPTCHA' : verdict === 'risk' ? 'SMS_VERIFICATION' : 'TOS_CONFIRMATION';
            const reasonCode = verdict === 'captcha' ? 'CAPTCHA_CHALLENGE' : verdict === 'risk' ? 'RISK_CONTROL_WALL' : 'UNEXPECTED_PAGE';
            const handoffPath = await handoff({
              status: 'blocked_pending_review',
              accountId: input.persona.accountId,
              step: step.id,
              expect: step.expect ?? null,
              reason: reasonCode,
              evidence: `${String(i).padStart(2, '0')}-${step.id}.png`,
              attempts: attempt + 1,
              createdAt: new Date().toISOString(),
            });
            yield* validated({
              kind: 'HUMAN_GATE',
              gate,
              interventionCategory: PROVISION_GATE_INTERVENTION_CATEGORY,
              reasonCode,
              ...(handoffPath ? { handoffRef: handoffPath } : {}),
            }, state);
            yield* validated({ kind: 'STATE_TRANSITION', to: 'AWAITING_HUMAN', reasonCode: 'HUMAN_GATE_OPEN' }, state);
            return; // parked at the gate — resume via drive(input, {resumeFromStep})
          }
          if (verdict === 'ok') done = true;
          else if (verdict === null) done = true; // blind mode: table trusts itself
        }
        if (!done) {
          yield* validated({ kind: 'TERMINAL_FAILURE', failureCode: `STEP_RETRY_EXHAUSTED_${step.id.toUpperCase().replace(/-/g, '_')}` }, state);
          return;
        }
        yield* validated({ kind: 'STEP_PROGRESS', step: step.id }, state);
        if (step.id === SIGNUP_COMPLETION_STEP) {
          yield* validated({ kind: 'STATE_TRANSITION', to: 'CREATED', reasonCode: 'SIGNUP_TOS_CONFIRMED' }, state);
          state = 'CREATED';
        }
      }
      return { endState: state, elapsedMs: Date.now() - started };
    },
  };
}
