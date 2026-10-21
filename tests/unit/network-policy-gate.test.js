/**
 * BR-B4 — network policy gate (the B1 seam implementation) + policy loading.
 *
 * Hermetic: fake db (tests/helpers/fakes.js), fake resolver, captured audit.
 * Covers the fail-closed contract (MD §5.1/§12):
 *   - policy not loaded / malformed (env AND AppSetting shapes) → POLICY_UNAVAILABLE
 *   - db read error / gate-internal throw → POLICY_UNAVAILABLE, the gate NEVER throws
 *   - taskType policy (AppSetting network.taskTypePolicy)
 *   - egress target collection (provider baseUrl + apiInternalUrl; mock/disabled/missing = none)
 *   - audit: actor=system, redacted target (no credentials), audit failure ≠ verdict change
 *   - env + AppSetting union; db==null → env-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NETWORK_GATE_ERROR,
  NETWORK_SETTING_KEYS,
  createNetworkPolicyGate,
} from '@water-army/shared';

import { makeFakeDb } from '../helpers/fakes.js';

const PUB = '93.184.216.34';
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const RESOLVE_MAP = {
  api: ['172.18.0.2'],
  'qa.example.com': [PUB],
  'evil.example.com': [PUB],
};
const resolve = async (h) => RESOLVE_MAP[h] ?? [PUB];

/** env with a fully valid policy (public + internal). */
const GOOD_ENV = {
  QA_ENDPOINT_ALLOWLIST: 'https://qa.example.com',
  QA_ENDPOINT_ALLOWLIST_INTERNAL: 'http://api:3000',
};

function makeGate({ env = {}, db = null, config = {}, audit = null, resolve: res = resolve } = {}) {
  const audited = [];
  const gate = createNetworkPolicyGate({
    getDb: () => db,
    env,
    config,
    log: SILENT,
    resolve: res,
    audit: audit ? (e) => { audited.push(e); return Promise.resolve(); } : null,
  });
  return { gate, audited };
}

/** Seed a run row (+ optional provider row) and return the run id. */
async function seedRun(db, { id = 'run-1', provider = 'mock', baseUrl = 'https://qa.example.com', isEnabled = true } = {}) {
  if (provider && provider !== 'mock') {
    await db.providerConfig.create({ data: { name: provider, baseUrl, isEnabled } });
  }
  await db.taskRun.create({ data: { id, inputJson: { prompt: 'x', provider } } });
  return id;
}

/**
 * BR-B6 G3: the allow verdict now carries the pin payload (pins + entries +
 * resolve) that the provider's pinned transport needs. Assert the contract
 * shape instead of an exact object match.
 */
function assertAllowed(v, msg = 'verdict must allow') {
  assert.equal(v.allowed, true, msg);
  assert.ok(Array.isArray(v.pins), 'allow verdict carries the pin set');
  assert.ok(v.entries && Array.isArray(v.entries.public) && Array.isArray(v.entries.internal), 'allow verdict carries the policy entries');
  assert.equal(typeof v.resolve, 'function', 'allow verdict carries the resolver');
}

const CTX = { runId: 'run-1', attempt: 1, identityId: 'ident-1', batchId: 'batch-1', taskType: 'adhoc' };

// ---------------------------------------------------------------------------
// Fail-closed: policy unavailable
// ---------------------------------------------------------------------------

test('policy unavailable: no env + no AppSetting → POLICY_UNAVAILABLE + system audit', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({ db });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  const rows = db.__state.auditRows;
  assert.equal(rows.length, 1, 'every deny writes an audit row');
  const row = rows[0];
  assert.equal(row.action, 'network_policy_deny');
  assert.equal(row.actorUserId, null, 'actor = system (no user id)');
  assert.equal(row.resourceType, 'task_run');
  assert.equal(row.resourceId, runId);
  assert.equal(row.status, 'failure');
  assert.equal(row.detailsJson.actor, 'system');
  assert.equal(row.detailsJson.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  assert.equal(row.detailsJson.identityId, 'ident-1');
  assert.equal(row.detailsJson.batchId, 'batch-1');
  assert.equal(row.detailsJson.target, null);
});

test('policy unavailable: malformed env entry (wildcard) → POLICY_UNAVAILABLE, never a partial policy', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({ db, env: { QA_ENDPOINT_ALLOWLIST: 'https://qa.example.com, https://*.example.com' } });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  assert.match(v.reason, /wildcard/);
});

test('policy unavailable: AppSetting allowlist has the wrong shape (not an array)', async () => {
  const db = makeFakeDb();
  await db.appSetting.upsert({
    where: { key: NETWORK_SETTING_KEYS.ALLOWLIST },
    update: { valueJson: { entries: ['https://qa.example.com'] } },
    create: { key: NETWORK_SETTING_KEYS.ALLOWLIST, valueJson: { entries: ['https://qa.example.com'] } },
  });
  const { gate } = makeGate({ db });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
  assert.match(v.reason, /must be a JSON array/);
});

test('policy unavailable: AppSetting allowlist contains a malformed entry (even if env is fine)', async () => {
  const db = makeFakeDb();
  await db.appSetting.upsert({
    where: { key: NETWORK_SETTING_KEYS.ALLOWLIST },
    update: { valueJson: ['https://*.bad.example.com'] },
    create: { key: NETWORK_SETTING_KEYS.ALLOWLIST, valueJson: ['https://*.bad.example.com'] },
  });
  const { gate } = makeGate({ db, env: GOOD_ENV });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
});

test('policy unavailable: AppSetting taskTypePolicy with an unknown key → POLICY_UNAVAILABLE', async () => {
  const db = makeFakeDb();
  await db.appSetting.upsert({
    where: { key: NETWORK_SETTING_KEYS.TASK_TYPES },
    update: { valueJson: { ai: true, adhoc: true, superuser: false } },
    create: { key: NETWORK_SETTING_KEYS.TASK_TYPES, valueJson: { ai: true, adhoc: true, superuser: false } },
  });
  const { gate } = makeGate({ db, env: GOOD_ENV });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
});

test('policy unavailable: AppSetting taskTypePolicy with a non-boolean → POLICY_UNAVAILABLE', async () => {
  const db = makeFakeDb();
  await db.appSetting.upsert({
    where: { key: NETWORK_SETTING_KEYS.TASK_TYPES },
    update: { valueJson: { ai: 'yes' } },
    create: { key: NETWORK_SETTING_KEYS.TASK_TYPES, valueJson: { ai: 'yes' } },
  });
  const { gate } = makeGate({ db, env: GOOD_ENV });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
});

test('policy unavailable: DB read error → POLICY_UNAVAILABLE (cannot prove the policy fully loaded)', async () => {
  const db = makeFakeDb();
  const original = db.appSetting.findUnique;
  db.appSetting.findUnique = async () => {
    throw new Error('relation "app_settings" does not exist');
  };
  const { gate } = makeGate({ db, env: GOOD_ENV });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  db.appSetting.findUnique = original;
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// Load paths: env-only, db==null, union
// ---------------------------------------------------------------------------

test('allow: db==null + env policy + no egress targets (mock provider, no api url) → allow (env-only path)', async () => {
  const { gate } = makeGate({ db: null, env: GOOD_ENV });
  const v = await gate(CTX);
  assertAllowed(v);
  assert.equal(v.pins.length, 0, 'no egress targets → empty pin set');
});

test('allow: env + AppSetting union — an entry living ONLY in AppSetting is honored', async () => {
  const db = makeFakeDb();
  await db.appSetting.upsert({
    where: { key: NETWORK_SETTING_KEYS.ALLOWLIST },
    update: { valueJson: ['https://only-in-db.example.com'] },
    create: { key: NETWORK_SETTING_KEYS.ALLOWLIST, valueJson: ['https://only-in-db.example.com'] },
  });
  const { gate } = makeGate({ db, env: GOOD_ENV });
  const runId = await seedRun(db, { provider: 'dbonly', baseUrl: 'https://only-in-db.example.com' });
  const v = await gate({ ...CTX, runId });
  assertAllowed(v, 'AppSetting-only entry must be part of the policy');
  assert.equal(v.pins.length, 1);
  assert.deepEqual(v.pins[0].pinnedIps, [PUB], 'the pin carries the validated IP (G3 payload)');
});

// ---------------------------------------------------------------------------
// taskType policy
// ---------------------------------------------------------------------------

test('taskType policy: adhoc disabled in AppSetting → adhoc runs denied, ai runs pass', async () => {
  const db = makeFakeDb();
  await db.appSetting.upsert({
    where: { key: NETWORK_SETTING_KEYS.TASK_TYPES },
    update: { valueJson: { ai: true, adhoc: false } },
    create: { key: NETWORK_SETTING_KEYS.TASK_TYPES, valueJson: { ai: true, adhoc: false } },
  });
  const { gate } = makeGate({ db, env: GOOD_ENV });
  const runId = await seedRun(db);
  const vAdhoc = await gate({ ...CTX, runId, taskType: 'adhoc' });
  assert.equal(vAdhoc.allowed, false);
  assert.equal(vAdhoc.code, NETWORK_GATE_ERROR.TARGET_DENIED);
  assert.match(vAdhoc.reason, /adhoc/);
  const vAi = await gate({ ...CTX, runId, taskType: 'ai' });
  assertAllowed(vAi);
});

// ---------------------------------------------------------------------------
// Egress target collection + assessment
// ---------------------------------------------------------------------------

test('allow: mock provider + api internal target on the internal list', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({ db, env: GOOD_ENV, config: { apiInternalUrl: 'http://api:3000' } });
  const runId = await seedRun(db); // provider mock
  const v = await gate({ ...CTX, runId });
  assertAllowed(v);
  assert.equal(v.pins.length, 1, 'the api-internal target is pinned');
  assert.equal(v.pins[0].host, 'api');
  assert.deepEqual(v.pins[0].pinnedIps, ['172.18.0.2']);
});

test('deny: provider baseUrl NOT on the allowlist → TARGET_DENIED + redacted audit target', async () => {
  const db = makeFakeDb();
  const { gate, audited } = makeGate({ db, env: GOOD_ENV, config: {}, audit: async () => {} });
  const runId = await seedRun(db, { provider: 'evil', baseUrl: 'https://evil.example.com/steal' });
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.TARGET_DENIED);
  // audit redaction: host:port only — the path /steal must not reach the audit trail
  assert.equal(audited.length, 1);
  // WHATWG omits the IMPLICIT port in URL.port — https://host == :443.
  // redactTarget keeps it minimal (explicit non-default ports are still shown).
  assert.equal(audited[0].details.target, 'https://evil.example.com');
  assert.ok(!JSON.stringify(audited[0].details).includes('/steal'), 'no path in audit');
});

test('deny: provider baseUrl resolves to loopback → BLOCKED_IP (SSRF even for a "real" provider config)', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({
    db,
    env: GOOD_ENV,
    resolve: async (h) => (h === 'qa.example.com' ? ['127.0.0.1'] : RESOLVE_MAP[h] ?? [PUB]),
  });
  const runId = await seedRun(db, { provider: 'qa', baseUrl: 'https://qa.example.com' });
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.BLOCKED_IP);
});

test('allow (no target): provider row MISSING → gate passes; the provider resolver hard-fails the run pre-network', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({ db, env: GOOD_ENV });
  const run = await db.taskRun.create({ data: { id: 'run-ghost', inputJson: { provider: 'ghost' } } });
  const runId = run.id;
  const v = await gate({ ...CTX, runId });
  assertAllowed(v, 'nothing to fence — run fails at provider resolution, not at the gate');
});

test('allow (no target): provider DISABLED → skipped (the resolver would reject it pre-network)', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({ db, env: GOOD_ENV });
  const runId = await seedRun(db, { provider: 'off', baseUrl: 'https://notlisted.example.com', isEnabled: false });
  const v = await gate({ ...CTX, runId });
  assertAllowed(v);
});

test('deny: apiInternalUrl off the internal list → TARGET_DENIED (the tool path is fenced too)', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({ db, env: GOOD_ENV, config: { apiInternalUrl: 'http://attacker.example.com:9999' } });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.TARGET_DENIED);
});

test('deny: provider baseUrl with userinfo → BAD_TARGET + audit carries NO credentials', async () => {
  const db = makeFakeDb();
  const { gate, audited } = makeGate({ db, env: GOOD_ENV, audit: async () => {} });
  const runId = await seedRun(db, { provider: 'cred', baseUrl: 'https://user:SuperSecretP@ss@qa.example.com' });
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.BAD_TARGET);
  const auditText = JSON.stringify(audited);
  assert.ok(!auditText.includes('SuperSecretP@ss'), 'credential must never reach the audit trail');
  assert.ok(!auditText.includes('user:'), 'userinfo must never reach the audit trail');
  assert.equal(audited[0].details.target, 'https://qa.example.com'); // implicit :443 omitted (WHATWG)
});

// ---------------------------------------------------------------------------
// The gate NEVER throws (fail-closed, not crash-out)
// ---------------------------------------------------------------------------

test('gate never throws: run-row read error → POLICY_UNAVAILABLE (verdict, not exception)', async () => {
  const db = makeFakeDb();
  const original = db.taskRun.findUnique;
  db.taskRun.findUnique = async () => {
    throw new Error('db down');
  };
  const { gate } = makeGate({ db, env: GOOD_ENV });
  let v;
  await assert.doesNotReject(async () => {
    v = await gate(CTX);
  });
  db.taskRun.findUnique = original;
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
});

test('gate never throws: resolver throwing mid-assessment → RESOLUTION_FAILED (verdict, not exception)', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({
    db,
    env: GOOD_ENV,
    config: { apiInternalUrl: 'http://api:3000' },
    resolve: async () => {
      throw new Error('EAI_AGAIN');
    },
  });
  const runId = await seedRun(db);
  let v;
  await assert.doesNotReject(async () => {
    v = await gate({ ...CTX, runId });
  });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.RESOLUTION_FAILED);
});

test('audit sink failure does NOT change the verdict (deny still returned, failure logged only)', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({
    db,
    env: {}, // → POLICY_UNAVAILABLE path (guaranteed deny)
    audit: async () => {
      throw new Error('audit table locked');
    },
  });
  let v;
  await assert.doesNotReject(async () => {
    v = await gate(CTX);
  });
  assert.equal(v.allowed, false);
  assert.equal(v.code, NETWORK_GATE_ERROR.POLICY_UNAVAILABLE);
});

test('default audit sink (no custom audit): deny row lands in audit_events via the db', async () => {
  const db = makeFakeDb();
  const { gate } = makeGate({ db, env: GOOD_ENV, config: { apiInternalUrl: 'http://nowhere.example.com' } });
  const runId = await seedRun(db);
  const v = await gate({ ...CTX, runId });
  assert.equal(v.allowed, false);
  assert.equal(db.__state.auditRows.length, 1);
  assert.equal(db.__state.auditRows[0].action, 'network_policy_deny');
});
