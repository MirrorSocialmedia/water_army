/**
 * GAcct 段4 unit — create-account step table + signup driver (ADR-034 §5/§7).
 * Hermetic: fake adb injection (argv recorder), fake screencap, injected
 * classifier/verdicts — zero real devices, zero timers (sleep → 0).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CREATE_ACCOUNT_STEPS,
  SIGNUP_COORD_BASE,
  SIGNUP_COMPLETION_STEP,
  deriveSignupValues,
  resolveStepAction,
  createSignupDriver,
} from '../../packages/shared/src/account-signup-steps.js';
import { generatePersona } from '../../packages/shared/src/account-persona.js';
import { validateProvisionEvent, PROVISION_EVENT_KINDS, PROVISION_GATE_INTERVENTION_CATEGORY } from '../../packages/shared/src/account-provision-contract.js';
import { ACCOUNT_STATES, isLegalAccountTransition } from '../../packages/shared/src/gmail-provision.js';

const C32 = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const mkId = (i) => { let s = ''; let x = i + 1; for (let k = 0; k < 10; k++) { s += C32[x % 30]; x = Math.floor(x / 30) + k * 7 + 1; } return `acct-${s}`; };
const mkPersona = (i = 3, region = 'hk') => generatePersona(mkId(i), { role: 'farm', region });
const mkInput = (region) => {
  const persona = mkPersona(3, region);
  return { persona, credentials: { email: `${persona.gmail.prefix}@gmail.com`, password: persona.password } };
};

function fakeCtx({ verdicts = {}, screen = SIGNUP_COORD_BASE } = {}) {
  const calls = [];
  const evidence = [];
  const handoffs = [];
  const ctx = {
    calls, evidence, handoffs,
    runAdb: async (args) => { calls.push(args.join(' ')); return ''; },
    screencap: async () => Buffer.from(`PNG-${calls.length}`),
    screen,
    sleep: async () => {},
    writeEvidence: async (name) => { evidence.push(name); },
    handoff: async (rec) => { handoffs.push(rec); return `/tmp/handoff-${handoffs.length}.json`; },
    classify: (buf, step) => {
      const v = verdicts[step.id];
      return typeof v === 'function' ? v(buf) : (v ?? null);
    },
  };
  return ctx;
}

async function collect(driver, input, opts) {
  const events = [];
  for await (const ev of driver.drive(input, opts)) events.push(ev);
  return events;
}

test('step table: unique ids, phone-skip HARD micro-swipe discipline, no KEYCODE_BACK anywhere', () => {
  const ids = CREATE_ACCOUNT_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'step ids unique');
  const phoneSkip = CREATE_ACCOUNT_STEPS.find((s) => s.id === 'skip-phone');
  assert.equal(phoneSkip.action.kind, 'micro-swipe');
  assert.equal(phoneSkip.hardDiscipline, 'phone-skip-zero-sms');
  // gotcha ③: KEYCODE_BACK never appears in the flow
  for (const s of CREATE_ACCOUNT_STEPS) {
    assert.notEqual(s.action.kind, 'key', `step ${s.id} uses a key action`);
    assert.equal(JSON.stringify(s).includes('BACK'), false);
  }
  assert.equal(CREATE_ACCOUNT_STEPS.at(-1).id, SIGNUP_COMPLETION_STEP);
});

test('resolveStepAction: coordinate scaling + micro-swipe gesture shape', () => {
  const step = CREATE_ACCOUNT_STEPS.find((s) => s.id === 'skip-phone');
  const r = resolveStepAction(step, { screen: { w: 1440, h: 2560 } });
  assert.deepEqual(r.cmd, ['input', 'swipe', '1280', '2300', '1280', '2299', '120']);
  const tap = resolveStepAction(CREATE_ACCOUNT_STEPS.find((s) => s.id === 'tos-confirm'), { screen: SIGNUP_COORD_BASE });
  assert.deepEqual(tap.cmd, ['input', 'tap', '630', '1206']);
});

test('deriveSignupValues: persona → typed fields, gender mapping, password pair', () => {
  const p = mkPersona(3, 'hk');
  const v = deriveSignupValues(p);
  assert.equal(v.username, p.gmail.prefix);
  assert.equal(v.givenName, p.name.givenName);
  assert.equal(v.password, p.password);
  assert.equal(v.confirmPassword, p.password);
  assert.equal(v.year, p.birthday.slice(0, 4));
  assert.equal(v.gender, p.gender);
  assert.ok(['male', 'female'].includes(v.genderField));
});

test('driver (blind, happy path): full legal event stream to CREATED, evidence per step, micro-swipe issued, no secrets in events', async () => {
  const ctx = fakeCtx();
  const driver = createSignupDriver(ctx);
  const input = mkInput('hk');
  const events = await collect(driver, input);
  assert.ok(events.length >= CREATE_ACCOUNT_STEPS.length + 2);
  // contract: every event kind legal; STATE_TRANSITION matrix-valid from PREPARING
  let state = 'PREPARING';
  for (const ev of events) {
    assert.ok(PROVISION_EVENT_KINDS.includes(ev.kind), `kind ${ev.kind}`);
    assert.deepEqual(validateProvisionEvent(ev, { fromState: state }), []);
    if (ev.kind === 'STATE_TRANSITION') {
      assert.ok(isLegalAccountTransition(state, ev.to));
      state = ev.to;
    }
    assert.equal(JSON.stringify(ev).includes(input.credentials.password), false, 'password leaked into event');
  }
  assert.equal(state, 'CREATED');
  assert.equal(events.filter((e) => e.kind === 'STEP_PROGRESS').length, CREATE_ACCOUNT_STEPS.length);
  // evidence: one screencap per step
  assert.equal(ctx.evidence.length, CREATE_ACCOUNT_STEPS.length);
  // skip-phone actually issued the micro swipe at baseline coords
  assert.ok(ctx.calls.some((c) => c === 'input swipe 640 1150 640 1149 120'), 'micro-swipe issued');
  // typed username lands on-device but NOT in events
  assert.ok(ctx.calls.some((c) => c.startsWith('input text ')));
  assert.equal(JSON.stringify(events).includes(input.persona.gmail.prefix), false, 'email/username leaked into events');
});

test('driver: captcha verdict → HUMAN_GATE (EXTERNAL_VERIFICATION) + handoff file record + AWAITING_HUMAN, no auto-clear', async () => {
  const ctx = fakeCtx({ verdicts: { 'fill-username': 'captcha' } });
  const driver = createSignupDriver(ctx);
  const events = await collect(driver, mkInput('hk'));
  const gate = events.find((e) => e.kind === 'HUMAN_GATE');
  assert.ok(gate);
  assert.equal(gate.gate, 'CAPTCHA');
  assert.equal(gate.interventionCategory, PROVISION_GATE_INTERVENTION_CATEGORY);
  assert.equal(gate.gateCleared, undefined, 'no auto-clear');
  assert.ok(gate.handoffRef);
  const last = events.at(-1);
  assert.equal(last.kind, 'STATE_TRANSITION');
  assert.equal(last.to, 'AWAITING_HUMAN');
  // handoff record: blocked_pending_review semantics, ZERO secrets
  assert.equal(ctx.handoffs.length, 1);
  const rec = ctx.handoffs[0];
  assert.equal(rec.status, 'blocked_pending_review');
  assert.equal(rec.step, 'fill-username');
  assert.equal(rec.evidence.endsWith('fill-username.png'), true);
  const pw = mkInput('hk').credentials.password;
  assert.equal(JSON.stringify(rec).includes(pw), false, 'handoff carries no password');
});

test('driver: risk verdict maps to SMS_VERIFICATION gate (phone-demand wall)', async () => {
  const ctx = fakeCtx({ verdicts: { 'fill-username': 'risk' } });
  const events = await collect(createSignupDriver(ctx), mkInput('hk'));
  const gate = events.find((e) => e.kind === 'HUMAN_GATE');
  assert.equal(gate.gate, 'SMS_VERIFICATION');
  assert.equal(gate.reasonCode, 'RISK_CONTROL_WALL');
});

test('driver: unknown verdict retries the step then TERMINAL_FAILURE (never infinite)', async () => {
  const ctx = fakeCtx({ verdicts: { 'recovery-empty': 'unknown-page' } });
  const events = await collect(createSignupDriver(ctx), mkInput('us'));
  const term = events.find((e) => e.kind === 'TERMINAL_FAILURE');
  assert.ok(term);
  assert.equal(term.failureCode, 'STEP_RETRY_EXHAUSTED_RECOVERY_EMPTY');
  // retries: recovery-empty has retries 0 → executed exactly once
  assert.equal(ctx.evidence.filter((e) => e.includes('recovery-empty')).length, 1);
});

test('driver: retries=2 step re-executes on unknown verdict before failing', async () => {
  const ctx = fakeCtx({ verdicts: { 'fill-username': 'unknown-page' } });
  const events = await collect(createSignupDriver(ctx), mkInput('us'));
  assert.equal(ctx.evidence.filter((e) => e.includes('fill-username')).length, 3); // 1 + 2 retries
  assert.ok(events.some((e) => e.kind === 'TERMINAL_FAILURE'));
});

test('driver: resumeFromStep continues AFTER the cleared gate step', async () => {
  const ctx = fakeCtx();
  const events = await collect(createSignupDriver(ctx), mkInput('hk'), { resumeFromStep: 'fill-username' });
  const steps = events.filter((e) => e.kind === 'STEP_PROGRESS').map((e) => e.step);
  assert.equal(steps[0], 'fill-password');
  assert.equal(steps.includes('fill-username'), false);
  assert.equal(events.at(-1).to, 'CREATED');
  const c2 = fakeCtx();
  await assert.rejects(collect(createSignupDriver(c2), mkInput('hk'), { resumeFromStep: 'nope-step' }), /unknown resumeFromStep/);
});

test('driver: invalid input rejected by the contract validator', async () => {
  const ctx = fakeCtx();
  await assert.rejects(() => collect(createSignupDriver(ctx), { persona: {} }), /invalid input/);
});

test('driver: non-hk persona without gender still walks the table (gender tap default)', async () => {
  const persona = { ...mkPersona(9, 'us'), gender: undefined, hk: undefined };
  const ctx = fakeCtx();
  const events = await collect(createSignupDriver(ctx), { persona, credentials: { email: 'x@gmail.com', password: persona.password } });
  assert.equal(events.at(-1).to, 'CREATED');
  assert.equal(ACCOUNT_STATES.includes('CREATED'), true);
});

// ---------------------------------------------------------------------------
// CLI surface (signup --dry-run + schedule) — spawn-level, tmpdir vault
// ---------------------------------------------------------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'apps/api/src/cli/account-gen.js');
const KEY = 'signup-cli-test-key-0123456789abcdef';

function cli(args, storePath) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, APP_ENCRYPTION_KEY: KEY, ACCOUNT_REGISTRY_PATH: storePath },
  });
}

test('CLI: signup --dry-run prints the step plan for a vaulted account, no password leaked', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacct-signup-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'registry.json');
  const created = cli(['create', '--role', 'farm', '--region', 'hk', '--show'], storePath);
  const id = created.trim().split(/\s+/)[0];
  const pw = created.match(/password: (\S+)/)[1];
  const out = cli(['signup', id, '--dry-run'], storePath);
  assert.match(out, /signup plan for acct-/);
  assert.match(out, /skip-phone\s+micro-swipe\s+@\[640,1150\]\s+HARD:phone-skip-zero-sms/);
  assert.ok(!out.includes(pw), 'dry-run masks the vault password');
  assert.match(out, /password=<vault>/);
});

test('CLI: schedule emits a deterministic masked plan (seeded, daylit, gap-respecting)', () => {
  const args = ['schedule', '--count', '6', '--window', '24h', '--seed', 'cli-test', '--start', '2026-11-04T00:00:00Z', '--min-gap', '10'];
  const a = cli(args, path.join(os.tmpdir(), 'gacct-unused-schedule.json'));
  const b = cli(args, path.join(os.tmpdir(), 'gacct-unused-schedule.json'));
  assert.equal(a, b);
  const rows = a.trim().split('\n').filter((l) => /^\s*\d+\s/.test(l));
  assert.equal(rows.length, 6);
  assert.match(a, /avoidNight=true/);
  const stamps = rows.map((r) => Date.parse(r.trim().split(/\s+/)[1]));
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i] - stamps[i - 1] >= 10 * 60_000 - 1);
    const h = new Date(stamps[i] + 8 * 3600_000).getUTCHours();
    assert.ok(h >= 7, `night hour ${h}`);
  }
});
