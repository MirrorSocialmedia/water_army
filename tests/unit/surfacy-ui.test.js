/**
 * WA-UI-SURFACY s5 — adversarial suite for the surfaced UI (pure logic +
 * render proofs; zero new dependencies — react/react-dom are hoisted from
 * the web workspace, same as the SSR smoke test's toolchain).
 *
 * Threats covered (工單 對抗測試):
 *  1. XSS in free text (displayName/profile payloads) — React text-node
 *     escaping PROVEN by rendering, not assumed; plus a structural ban on
 *     dangerouslySetInnerHTML in the surfaced pages.
 *  2. 300-char strings — honest preview truncation + the word-break class
 *     exists in the stylesheet (layout cannot be broken by one long token).
 *  3. 409 conflicts (fingerprint collision / egress IP taken) → the UI copy
 *     path returns the server message (never a white screen).
 *  4. API 500 / offline → honest errorText for StateFrame's error frame.
 *  5. viewer role → every admin/operator action gate is false (mirrors the
 *     backend requireRole matrix).
 *  6. double click → busy guard submits exactly once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  canManageFleetProfiles,
  canOperateLifecycle,
  canMutateDeviceApps,
  canViewPolicy,
  surfacyCan,
  errorText,
  conflictText,
  forbiddenText,
  isSwitchDisabled,
  previewText,
  LONG_TEXT_CLASS,
  createBusyGuard,
  validateEgressForm,
  validReasonCode,
  ACCOUNT_STATES,
  formatCollisionRow,
  fmtMiB,
  fmtMs,
  zonesFromPolicyRows,
  zonesToBody,
  zonesMatchServer,
  parseZoneLines,
  POLICY_ZONE_KEYS,
} from '../../apps/web/src/lib/surfacy-ui.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const XSS = '<img src=x onerror=alert(1)>';

// ------------------------------------------------------------------- XSS ---
test('xss: React text-node rendering escapes hostile displayName (PROVEN, not assumed)', () => {
  // This is exactly how every surfaced cell renders text ({value} in JSX).
  const html = renderToStaticMarkup(createElement('span', { class: LONG_TEXT_CLASS }, XSS));
  assert.ok(!html.includes('<img'), `escaped markup must not contain a live <img>: ${html}`);
  assert.ok(!/<[a-zA-Z][^>]*onerror/i.test(html), `no live element may carry the injected handler: ${html}`);
  assert.ok(html.includes('&lt;img'), 'payload must be present but escaped (honest display)');
  assert.ok(html.includes('alert(1)'), 'display stays faithful — the user sees what was stored');
});

test('xss: an attribute-injection payload cannot escape attribute quoting either', () => {
  const hostile = '"><script>alert(2)</script>';
  const html = renderToStaticMarkup(createElement('div', { title: 'x' }, createElement('b', null, hostile)));
  assert.ok(!html.includes('<script>'), html);
  assert.ok(!html.includes('"><script'), `quote must be entity-escaped, never re-open a tag: ${html}`);
  assert.ok(html.includes('&quot;&gt;'), 'payload shown faithfully but escaped');
});

test('xss: surfaced pages never use dangerouslySetInnerHTML (structural ban)', () => {
  const pages = [
    'apps/web/src/pages/IdentityDetail.jsx',
    'apps/web/src/pages/DeviceDetail.jsx',
    'apps/web/src/pages/Settings.jsx',
  ];
  for (const p of pages) {
    const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
    assert.ok(!src.includes('dangerouslySetInnerHTML'), `${p} renders raw HTML — text-node safety no longer structural`);
  }
});

// ------------------------------------------------------------ long string ---
test('300-char payload: honest truncation + word-break class wired into the stylesheet', () => {
  const long = 'A字bc'.repeat(75); // 300 chars incl. multi-byte CJK
  assert.equal(long.length, 300);
  const preview = previewText(long, 120);
  assert.ok(preview.length < long.length, 'preview must truncate');
  assert.ok(preview.includes('(+180 more)'), preview, 'counter must be honest about what is hidden');
  assert.equal(previewText('short'), 'short');
  assert.equal(previewText(null), '');
  // the class the surfaced cells apply must exist and break long tokens
  const css = fs.readFileSync(path.join(ROOT, 'apps/web/src/styles/app.css'), 'utf8');
  assert.match(css, new RegExp(`\\.${LONG_TEXT_CLASS}\\s*\\{[^}]*overflow-wrap:\\s*anywhere`), 'word-break css missing');
});

// ---------------------------------------------------------------- 409/4xx ---
test('409 conflict (fingerprint collision / egress IP taken) → server message shown verbatim', () => {
  const e = Object.assign(new Error('expectedEgressIp 1.2.3.4 is already bound to identity 0a1b…'), {
    name: 'ApiError',
    status: 409,
    code: 'CONFLICT',
    requestId: 'req-42',
  });
  const text = conflictText(e);
  assert.ok(text.startsWith('衝突 (409)'));
  assert.ok(text.includes('already bound'), 'server message verbatim');
  assert.equal(conflictText({ status: 500, message: 'boom' }), null, 'non-409 keeps the generic path');
  // and never empty/undefined for a real 409 — the frame always has copy
  assert.ok(conflictText({ status: 409 }).length > 0);
});

test('500 / offline → honest StateFrame error copy (code + message + request id)', () => {
  const off = { status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the API (Failed to fetch)' };
  assert.equal(errorText(off), 'NETWORK_ERROR: Cannot reach the API (Failed to fetch)');
  const boom = { status: 500, code: 'INTERNAL', message: 'boom', requestId: 'r9' };
  assert.equal(errorText(boom), 'INTERNAL: boom (request r9)');
  // unknown error shape still renders SOMETHING (no white screen branch)
  assert.equal(errorText({ status: 502 }), 'ERROR: unknown error');
  assert.equal(errorText(null), '');
  const f403 = { status: 403, message: 'route not registered' };
  assert.equal(forbiddenText(f403), '403 — not permitted for your role (route not registered)');
  assert.equal(forbiddenText({ status: 200 }), null);
});

test('503 switch guards match exact codes only (EGRESS_BINDING_DISABLED etc.)', () => {
  const d = { status: 503, code: 'EGRESS_BINDING_DISABLED' };
  assert.equal(isSwitchDisabled(d, 'EGRESS_BINDING_DISABLED'), true);
  assert.equal(isSwitchDisabled(d, 'APP_OPS_DISABLED'), false, 'a different 503 must not silence the error frame');
  assert.equal(isSwitchDisabled({ status: 500, code: 'EGRESS_BINDING_DISABLED' }, 'EGRESS_BINDING_DISABLED'), false);
  assert.equal(isSwitchDisabled(null, 'APP_OPS_DISABLED'), false);
});

// ------------------------------------------------------------------- RBAC ---
test('viewer sees NO admin/operator action affordances; matrix mirrors backend', () => {
  for (const [fn, name] of [
    [canManageFleetProfiles, 'fleet profiles'],
    [canOperateLifecycle, 'lifecycle'],
    [canMutateDeviceApps, 'device apps'],
    [canViewPolicy, 'policy'],
  ]) {
    assert.equal(fn('viewer'), false, `viewer must not have ${name}`);
    assert.equal(fn(undefined), false, 'unknown role fail-closed');
  }
  // operator: lifecycle + apps mutations, NOT fleet profiles / policy
  assert.equal(canOperateLifecycle('operator'), true);
  assert.equal(canMutateDeviceApps('operator'), true);
  assert.equal(canManageFleetProfiles('operator'), false);
  assert.equal(canViewPolicy('operator'), false);
  // admin: everything
  for (const fn of [canManageFleetProfiles, canOperateLifecycle, canMutateDeviceApps, canViewPolicy]) {
    assert.equal(fn('admin'), true);
  }
  // generic matrix — every surfaced action for all three roles
  const adminActions = [
    'fingerprint.generate', 'fingerprint.collisions', 'egress.write',
    'policy.read', 'policy.write', 'providers.read', 'config.summary',
  ];
  const opActions = ['lifecycle.transition', 'lifecycle.provision', 'apps.install', 'apps.uninstall'];
  const readActions = ['fingerprint.read', 'egress.read', 'lifecycle.read', 'apps.read', 'templates.read', 'definitions.read'];
  for (const a of adminActions) {
    assert.equal(surfacyCan('viewer', a), false, `viewer ${a}`);
    assert.equal(surfacyCan('operator', a), false, `operator ${a}`);
    assert.equal(surfacyCan('admin', a), true, `admin ${a}`);
  }
  for (const a of opActions) {
    assert.equal(surfacyCan('viewer', a), false, `viewer ${a}`);
    assert.equal(surfacyCan('operator', a), true, `operator ${a}`);
    assert.equal(surfacyCan('admin', a), true, `admin ${a}`);
  }
  for (const a of readActions) assert.equal(surfacyCan('viewer', a), true, `viewer ${a}`);
  assert.equal(surfacyCan('ghost', 'fingerprint.read'), true, 'any known-ish role reads (backend still gates)');
  assert.equal(surfacyCan('admin', 'unknown.action'), false, 'unknown action fail-closed');
});

// ------------------------------------------------------------- double click ---
test('double click submits exactly once (busy guard), unlocks after finally', async () => {
  const guard = createBusyGuard();
  let submits = 0;
  const submit = async () => {
    if (!guard.tryBegin()) return false;
    try {
      submits += 1;
      await Promise.resolve(); // simulate in-flight POST
      return true;
    } finally {
      guard.end();
    }
  };
  const [a, b] = await Promise.all([submit(), submit()]);
  assert.deepEqual([a, b], [true, false], 'second click must fire NOTHING');
  assert.equal(submits, 1);
  assert.equal(guard.busy, false, 'guard must release after completion');
  assert.equal(await submit(), true, 'a later deliberate click still works');
});

// ---------------------------------------------------------- form mirrors ---
test('egress form mirror matches the PUT schema bounds (backend stays authoritative)', () => {
  assert.deepEqual(validateEgressForm({ proxyUrl: 'socks5://h:1', expectedEgressIp: '172.38.223.1' }), {});
  const errs = validateEgressForm({ proxyUrl: 'short', expectedEgressIp: 'not-an-ip' });
  assert.ok(errs.proxyUrl && errs.expectedEgressIp);
  assert.ok(Object.keys(validateEgressForm({ proxyUrl: 'socks5://user:pa**@10.0.0.1:1080', expectedEgressIp: '8.8.8.8' })).length === 0);
  assert.equal(validReasonCode(''), true);
  assert.equal(validReasonCode('OPERATOR_OVERRIDE'), true);
  assert.equal(validReasonCode('bad code!'), false);
  assert.equal(ACCOUNT_STATES.length, 7);
  assert.ok(ACCOUNT_STATES.includes('AWAITING_HUMAN'));
});

// ---------------------------------------------------------------- format ---
test('formatters are null-safe and honest', () => {
  assert.equal(fmtMiB(1024), '1.0 GiB');
  assert.equal(fmtMiB(512), '512 MiB');
  assert.equal(fmtMiB(undefined), '—');
  assert.equal(fmtMs(120_000), '2 min');
  assert.equal(fmtMs(7_200_000), '2.0 h');
  assert.equal(fmtMs(null), '—');
  assert.equal(formatCollisionRow({ field: 'ro.serialno', value: 'x'.repeat(100), count: 2 }), `ro.serialno = ${'x'.repeat(60)}… (+40 more) ×2`);
});

// ------------------------------------------------ policy editor (F4 fix) ---
// Review finding F4: PolicyPanel textareas kept stale user text after
// pol.reload(), and an untouched editor could fire a PUT body {} that the
// backend honestly answered 400 "nothing to update". Pure helpers below make
// both behaviors testable; the page wiring is asserted structurally after.

test('f4: zonesFromPolicyRows seeds honest textareas from server rows', () => {
  const rows = {
    allowlist: { valueJson: ['*.google.com', 'cdn.example'] },
    allowlistInternal: { valueJson: [] },
  };
  assert.deepEqual(zonesFromPolicyRows(rows), { allowlist: '*.google.com\ncdn.example', allowlistInternal: '' });
  // missing row / missing valueJson / non-array → '' (never undefined text)
  assert.deepEqual(zonesFromPolicyRows({ allowlist: { valueJson: null } }), { allowlist: '', allowlistInternal: '' });
  assert.deepEqual(zonesFromPolicyRows({ allowlist: { valueJson: 'not-an-array' } }), { allowlist: '', allowlistInternal: '' });
  assert.deepEqual(zonesFromPolicyRows(undefined), { allowlist: '', allowlistInternal: '' });
});

test('f4: zonesFromPolicyRows RE-seeds when server state changes (reload truth)', () => {
  const before = zonesFromPolicyRows({ allowlist: { valueJson: ['a.com'] } });
  const after = zonesFromPolicyRows({ allowlist: { valueJson: ['b.com', 'c.com'] } });
  assert.equal(before.allowlist, 'a.com');
  assert.equal(after.allowlist, 'b.com\nc.com', 'a server change must produce different seed text — the page re-seeds on this signature');
});

test('f4: parseZoneLines trims and drops blanks; body always carries BOTH keys', () => {
  assert.deepEqual(parseZoneLines('  a.com \n\n  b.com\n'), ['a.com', 'b.com']);
  assert.deepEqual(parseZoneLines(''), []);
  assert.deepEqual(parseZoneLines(undefined), []);
  // The unedited editor on an EMPTY policy previously produced body {} → 400.
  assert.deepEqual(zonesToBody({}), { allowlist: [], allowlistInternal: [] });
  assert.deepEqual(zonesToBody(null), { allowlist: [], allowlistInternal: [] });
  assert.deepEqual(POLICY_ZONE_KEYS, ['allowlist', 'allowlistInternal']);
});

test('f4: zonesMatchServer disables no-op saves but allows explicit clears', () => {
  const rows = { allowlist: { valueJson: ['a.com', 'b.com'] }, allowlistInternal: { valueJson: ['i.com'] } };
  // untouched editor (seed text, even with whitespace noise) = unchanged
  assert.equal(zonesMatchServer(zonesFromPolicyRows(rows), rows), true);
  assert.equal(zonesMatchServer({ allowlist: 'a.com\n\n  b.com  ', allowlistInternal: 'i.com' }, rows), true);
  // explicit clear differs from server → save allowed (clearing is meaningful)
  assert.equal(zonesMatchServer({ allowlist: '', allowlistInternal: 'i.com' }, rows), false);
  // edits differ
  assert.equal(zonesMatchServer({ allowlist: 'a.com', allowlistInternal: 'i.com' }, rows), false);
  // empty server + untouched editor = unchanged → no 400-prone PUT
  assert.equal(zonesMatchServer(zonesFromPolicyRows({}), {}), true);
});

test('f4: PolicyPanel is wired controlled (structural — value= seed, no defaultValue, guarded Save)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/web/src/pages/DeviceDetail.jsx'), 'utf8');
  const panel = src.slice(src.indexOf('function PolicyPanel'));
  assert.ok(panel, 'PolicyPanel not found');
  assert.ok(!panel.includes('defaultValue='), 'PolicyPanel textareas must be CONTROLLED (defaultValue never re-seeds on reload)');
  assert.match(panel, /value=\{zones\?\.\[key\]/, 'textareas must read from seeded zones state');
  assert.match(panel, /useEffect\([\s\S]{0,120}setZones[\s\S]{0,80}serverSig\]/, 'a serverSig-keyed effect must re-seed zones on every server change');
  assert.match(panel, /zonesMatchServer\(zones, rowsRef\.current\)/, 'saveZones must no-op-guard against unchanged editor content');
  assert.match(panel, /disabled=\{busy !== null \|\| unchanged\}/, 'Save button must be disabled while unchanged (empty/no-op save blocked in the UI)');
  assert.ok(!/const body = \{\};/.test(panel), 'the old hand-rolled body{} builder is gone — zonesToBody always sends both keys');
});

// ---------------------------- eager-children crash guards (found by F1 v2) ---
// StateFrame swaps in its empty/error frame at RENDER time, but the JSX passed
// as children is evaluated EAGERLY in the parent render — an unguarded
// `view.schemaVersion` / `account.state` inside children used to crash the
// whole page whenever the profile/lifecycle row did not exist yet (real page
// dead crashes caught by the v2 harness on a never-generated seed identity).
test('crash-guard: IdentityDetail StateFrame children are null-guarded', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/web/src/pages/IdentityDetail.jsx'), 'utf8');
  assert.match(src, /\{view \? \([\s\S]{0,400}schemaVersion/, 'fingerprint profile children must be wrapped in {view ? ... : null}');
  assert.match(src, /\{account \? \([\s\S]{0,400}account\.state/, 'account lifecycle children must be wrapped in {account ? ... : null}');
  // sibling discipline: these were already guarded — keep them that way
  assert.match(src, /\{b \? \([\s\S]{0,400}expectedEgressIp/, 'egress binding children must stay guarded');
  assert.match(src, /\{coll\.data \? \([\s\S]{0,200}blocking/, 'collision audit children must stay guarded');
});
