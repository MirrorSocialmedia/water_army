/**
 * BR-B3 — container lifecycle pure helpers (MD Phase 3):
 *   - container naming + docker-name safety
 *   - host-port range parsing + deterministic allocation
 *   - the label × DB OWNERSHIP DOUBLE CHECK (MD §4.3)
 *   - reconcile classification (DB vs docker)
 *   - ADB wire-protocol reply parsing (health = app layer, MD §8.2)
 *   - the 'container' adapter spec contract (+ validateBatchConfig wiring)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BATCH_LIFECYCLE_ERROR,
  BATCH_LIFECYCLE_ERROR_STATUS,
  BatchLifecycleError,
  APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST,
  containerNameForRun,
  parsePortRange,
  pickAvailablePort,
  ownershipVerdict,
  RECONCILE_STATES,
  reconcileVerdict,
  ADB_HOST_VERSION_CMD,
  parseAdbVersionReply,
  validateBatchConfig,
  validateContainerAdapterConfig,
  effectiveHealthProbe,
  effectiveWorkSpec,
  BATCH_ADAPTER_REGISTRY,
  CONTAINER_LABELS,
  buildContainerLabels,
} from '@water-army/shared';

const RUN = {
  id: 'r1',
  identityId: 'i1',
  batchId: 'b1',
  containerId: 'ctr-full-id-0001',
  status: 'running',
};
const LABELS_OK = buildContainerLabels({
  identityId: 'i1',
  batchId: 'b1',
  taskRunId: 'r1',
  createdBy: 'svc',
});

// ---------------------------------------------------------------- naming
test('containerNameForRun: deterministic, docker-name-safe, attempt-tagged', () => {
  const name = containerNameForRun('aabbccddeeff00112233445566778899', 2);
  assert.equal(name, 'wa-batch-aabbccddeeff00112233445566778899-a2');
  assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  assert.ok(name.length <= 255);
});

test('containerNameForRun: custom prefix must be name-safe', () => {
  assert.equal(containerNameForRun('aabbccddeeff0011', 1, 'br-b3-'), 'br-b3-aabbccddeeff0011-a1');
  assert.throws(() => containerNameForRun('aabbccddeeff0011', 1, '-bad-'), TypeError);
  assert.throws(() => containerNameForRun('aabbccddeeff0011', 1, 'way too long prefix that exceeds the limit'), TypeError);
  assert.throws(() => containerNameForRun('short', 1), TypeError);
  assert.throws(() => containerNameForRun('aabbccddeeff0011', 0), TypeError);
  assert.throws(() => containerNameForRun('aabbccddeeff0011', 1.5), TypeError);
});

test('containerNameForRun: >255 chars truncated deterministically', () => {
  const longRunId = 'x'.repeat(300);
  const name = containerNameForRun(longRunId, 1);
  assert.ok(name.length <= 255);
  assert.match(name, /^wa-batch-x{8}-a1$/);
});

// ---------------------------------------------------------------- ports
test('parsePortRange: single, range, and garbage', () => {
  assert.deepEqual(parsePortRange('16370-16419'), { start: 16370, end: 16419 });
  assert.deepEqual(parsePortRange('16370'), { start: 16370, end: 16370 });
  assert.deepEqual(parsePortRange(' 16370 - 16419 '), null); // spaces not in the contract
  assert.equal(parsePortRange('16419-16370'), null); // reversed
  assert.equal(parsePortRange('0-10'), null); // < 1
  assert.equal(parsePortRange('65535-65536'), null); // > 65535
  assert.equal(parsePortRange('abc'), null);
  assert.equal(parsePortRange(null), null);
  assert.equal(parsePortRange(16370), null); // string contract
});

test('pickAvailablePort: smallest free, blocks merged, exhaustion → null', () => {
  assert.equal(pickAvailablePort(16370, 16375, [], []), 16370);
  assert.equal(pickAvailablePort(16370, 16375, [16370], [16371, '16372']), 16373);
  assert.equal(pickAvailablePort(16370, 16370, [16370], []), null);
  assert.equal(pickAvailablePort(16370, 16370, [], [16370, 16370]), null); // dedupe
  assert.equal(pickAvailablePort(16370, 16372, [], [16371, 16372, 16370]), null);
});

// ---------------------------------------------------------------- ownership
test('ownershipVerdict: ok when labels AND db row both agree', () => {
  const v = ownershipVerdict(LABELS_OK, RUN, RUN.containerId);
  assert.equal(v.verdict, 'ok');
  assert.deepEqual(v.problems, []);
});

test('ownershipVerdict: label-only in the create→DB-write crash window', () => {
  const run = { ...RUN, containerId: null };
  const v = ownershipVerdict(LABELS_OK, run, 'whatever-the-container-is');
  assert.equal(v.verdict, 'label-only');
});

test('ownershipVerdict: every disagreement is a mismatch (never trust one source)', () => {
  // managed label missing
  assert.equal(ownershipVerdict({}, RUN, RUN.containerId).verdict, 'mismatch');
  // managed label not 'true'
  const unmanaged = { ...LABELS_OK, [CONTAINER_LABELS.MANAGED]: 'false' };
  assert.equal(ownershipVerdict(unmanaged, RUN, RUN.containerId).verdict, 'mismatch');
  // identity drift
  const badIdentity = { ...LABELS_OK, [CONTAINER_LABELS.IDENTITY_ID]: 'i-evil' };
  assert.equal(ownershipVerdict(badIdentity, RUN, RUN.containerId).verdict, 'mismatch');
  // batch drift
  const badBatch = { ...LABELS_OK, [CONTAINER_LABELS.BATCH_ID]: 'b-evil' };
  assert.equal(ownershipVerdict(badBatch, RUN, RUN.containerId).verdict, 'mismatch');
  // run-id drift
  const badRun = { ...LABELS_OK, [CONTAINER_LABELS.TASK_RUN_ID]: 'r-evil' };
  assert.equal(ownershipVerdict(badRun, RUN, RUN.containerId).verdict, 'mismatch');
  // run bound to a DIFFERENT container
  const boundElsewhere = { ...RUN, containerId: 'another-container' };
  assert.equal(ownershipVerdict(LABELS_OK, boundElsewhere, RUN.containerId).verdict, 'mismatch');
  // run row gone
  assert.equal(ownershipVerdict(LABELS_OK, null, RUN.containerId).verdict, 'mismatch');
  // non-batch run (no lineage)
  const adhoc = { id: 'r1', status: 'running' };
  assert.equal(ownershipVerdict(LABELS_OK, adhoc, RUN.containerId).verdict, 'mismatch');
});

test('ownershipVerdict: problems explain the mismatch', () => {
  const v = ownershipVerdict({ ...LABELS_OK, [CONTAINER_LABELS.BATCH_ID]: 'b-evil' }, RUN, RUN.containerId);
  assert.equal(v.verdict, 'mismatch');
  assert.ok(v.problems.some((p) => p.includes('b-evil')));
});

// ---------------------------------------------------------------- reconcile
test('reconcileVerdict: orphan when the run row is gone', () => {
  const v = reconcileVerdict({ run: null, containerRunning: true, leaseAlive: true, ownershipProblems: [] });
  assert.equal(v.state, 'orphan');
  assert.equal(v.fixable, true);
});

test('reconcileVerdict: terminal run + living container = orphan (fixable)', () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    const v = reconcileVerdict({
      run: { ...RUN, status },
      containerRunning: true,
      leaseAlive: true,
      ownershipProblems: [],
    });
    assert.equal(v.state, 'orphan', status);
    assert.equal(v.fixable, true, status);
  }
});

test('reconcileVerdict: lease expired (worker crash) = stale_running, stop-only fix', () => {
  const v = reconcileVerdict({ run: RUN, containerRunning: true, leaseAlive: false, ownershipProblems: [] });
  assert.equal(v.state, 'stale_running');
  assert.equal(v.fixable, true);
  const exited = reconcileVerdict({ run: RUN, containerRunning: false, leaseAlive: false, ownershipProblems: [] });
  assert.equal(exited.state, 'stale_running');
  assert.equal(exited.fixable, false); // nothing left to stop — the create-sweep owns the rest
});

test('reconcileVerdict: ownership disagreement = mismatch, NEVER fixable', () => {
  const v = reconcileVerdict({ run: RUN, containerRunning: true, leaseAlive: true, ownershipProblems: ['drift'] });
  assert.equal(v.state, 'mismatch');
  assert.equal(v.fixable, false);
});

test('reconcileVerdict: active run + live lease + container = ok (untouched)', () => {
  const v = reconcileVerdict({ run: RUN, containerRunning: true, leaseAlive: true, ownershipProblems: [] });
  assert.equal(v.state, 'ok');
  assert.equal(v.fixable, false);
});

test('RECONCILE_STATES is the closed classification set', () => {
  assert.deepEqual([...RECONCILE_STATES].sort(), ['db_only', 'mismatch', 'ok', 'orphan', 'stale_running', 'unbound']);
});

// ---------------------------------------------------------------- adb handshake
test('parseAdbVersionReply: valid length-prefixed reply', () => {
  const reply = Buffer.concat([Buffer.from('0005', 'ascii'), Buffer.from('0.0.1', 'ascii')]);
  const v = parseAdbVersionReply(reply);
  assert.equal(v.ok, true);
  assert.equal(v.version, '0.0.1');
});

test('parseAdbVersionReply: garbage is rejected, never "ok"', () => {
  assert.equal(parseAdbVersionReply(Buffer.alloc(0)).ok, false);
  assert.equal(parseAdbVersionReply(Buffer.from('xx', 'ascii')).ok, false); // non-hex prefix
  assert.equal(parseAdbVersionReply(Buffer.from('00f0deadbeef', 'ascii')).ok, false); // truncated payload
  assert.equal(parseAdbVersionReply('not a buffer').ok, false);
});

test('ADB_HOST_VERSION_CMD is the 12-char framed command', () => {
  assert.equal(ADB_HOST_VERSION_CMD, '000chost:version');
  assert.equal(ADB_HOST_VERSION_CMD.slice(4), 'host:version');
});

// ---------------------------------------------------------------- errors
test('BatchLifecycleError: stable code + default HTTP status', () => {
  const e = new BatchLifecycleError(BATCH_LIFECYCLE_ERROR.PORT_POOL_EXHAUSTED, 'no ports');
  assert.equal(e.apiCode, 'PORT_POOL_EXHAUSTED');
  assert.equal(e.statusCode, 503);
  assert.equal(e.name, 'BatchLifecycleError');
});

test('BATCH_LIFECYCLE_ERROR_STATUS: every code has a status', () => {
  for (const code of Object.values(BATCH_LIFECYCLE_ERROR)) {
    assert.ok(BATCH_LIFECYCLE_ERROR_STATUS[code] >= 400, code);
    assert.ok(BATCH_LIFECYCLE_ERROR_STATUS[code] < 600, code);
  }
});

test('app setting key is stable (B6/B5 depend on it)', () => {
  assert.equal(APP_SETTING_BATCH_CONTAINER_IMAGE_ALLOWLIST, 'batch.container_image_allowlist');
});

// ---------------------------------------------------------------- adapter spec
test('BATCH_ADAPTER_REGISTRY now carries the real container adapter', () => {
  assert.ok(BATCH_ADAPTER_REGISTRY.includes('container'));
  assert.ok(BATCH_ADAPTER_REGISTRY.includes('noop'));
});

test('validateContainerAdapterConfig: valid pinned image + probe + work', () => {
  assert.deepEqual(validateContainerAdapterConfig({
    image: 'water-army/redroid:14.0.0-240527-matrixa-r3',
    health: { kind: 'adb-tcp' },
    work: { kind: 'hold', durationMs: 60_000 },
  }), []);
  assert.deepEqual(validateContainerAdapterConfig({ image: 'foo/bar@sha256:' + 'a'.repeat(64) }), []);
  assert.deepEqual(validateContainerAdapterConfig({ image: 'foo/bar:1.2.3', work: { kind: 'none' } }), []);
});

test('validateContainerAdapterConfig: rejects unpinned/latest/bad shapes', () => {
  assert.ok(validateContainerAdapterConfig({ image: 'foo/bar' }).some((e) => e.includes('explicitly tagged')));
  assert.ok(validateContainerAdapterConfig({ image: 'foo/bar:latest' }).some((e) => e.includes('latest')));
  assert.ok(validateContainerAdapterConfig({ image: 'UPPER/case:1' }).some((e) => e.includes('pinned')));
  assert.ok(validateContainerAdapterConfig({ image: '' }).some((e) => e.includes('non-empty')));
  assert.ok(validateContainerAdapterConfig({ image: 'foo/bar:1', health: { kind: 'http' } }).some((e) => e.includes('kind')));
  assert.ok(validateContainerAdapterConfig({ image: 'foo/bar:1', health: { kind: 'tcp', port: 0 } }).some((e) => e.includes('port')));
  assert.ok(validateContainerAdapterConfig({ image: 'foo/bar:1', work: { kind: 'adb-script' } }).some((e) => e.includes('work.kind')));
  assert.ok(validateContainerAdapterConfig({ image: 'foo/bar:1', work: { kind: 'hold', durationMs: -1 } }).some((e) => e.includes('durationMs')));
  assert.ok(validateContainerAdapterConfig(null).some((e) => e.includes('plain object')));
});

test('validateBatchConfig: container adapter branch delegates to the spec validator', () => {
  assert.deepEqual(validateBatchConfig({ adapter: { type: 'container', image: 'foo/bar:1.0' } }), []);
  const errs = validateBatchConfig({ adapter: { type: 'container', image: 'foo/bar' } });
  assert.ok(errs.some((e) => e.includes('explicitly tagged')));
  assert.deepEqual(validateBatchConfig({ adapter: { type: 'unknown' } }), ['config.adapter.type must be one of noop | container (MD §2: 明確啟用)']);
});

test('effectiveHealthProbe: adb-tcp default + custom port', () => {
  assert.deepEqual(effectiveHealthProbe({}), { kind: 'adb-tcp', containerPort: 5555 });
  assert.deepEqual(effectiveHealthProbe({ health: { kind: 'tcp', port: 8080 } }), { kind: 'tcp', containerPort: 8080 });
  assert.deepEqual(effectiveHealthProbe({ health: { kind: 'none' } }), { kind: 'none', containerPort: 5555 });
  assert.deepEqual(effectiveHealthProbe({ health: { kind: 'bogus' } }).kind, 'adb-tcp'); // fail to the default, not open
});

test('effectiveWorkSpec: hold clamps, none is a zero-duration run', () => {
  assert.deepEqual(effectiveWorkSpec({}), { kind: 'hold', durationMs: 0 });
  assert.deepEqual(effectiveWorkSpec({ work: { kind: 'hold', durationMs: 999_999_999 } }), { kind: 'hold', durationMs: 3_600_000 });
  assert.deepEqual(effectiveWorkSpec({ work: { kind: 'none' } }), { kind: 'none', durationMs: 0 });
  assert.deepEqual(effectiveWorkSpec({ work: { kind: 'hold', durationMs: 1234 } }), { kind: 'hold', durationMs: 1234 });
});
