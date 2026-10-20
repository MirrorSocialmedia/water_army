/**
 * R4 (repair MD §6.2/§6.4) — the SINGLE network-state contract, verified at
 * every boundary from ONE canonical fixture:
 *
 *  1. `buildNetPayload` output key set = the MD §6.2 conceptual schema,
 *     mapped onto the existing names (lastSuccessAt ≙ lastSuccessfulCheckAt;
 *     lastErrorCode flat + lastError rich; checks{binary,process,interface,
 *     routePolicy,tcpCanary}).
 *  2. stale last-success → stale=true + networkReady=false (never
 *     "permanently healthy").
 *  3. the transition guard: BLOCKED→HEALTHY is IMPOSSIBLE (no edge), and
 *     VERIFYING→HEALTHY requires a fresh canary PASS as evidence.
 *  4. API / worker / UI read the SAME fixture and can never disagree:
 *     - worker `redroid.get_device_status` projection (tool-helpers) —
 *       dispatch gate === networkReady, zero secrets
 *     - UI `netStateBadge` / `netCheckBadge` (redroid-utils) — dispatch
 *       gate === networkReady, text labels, STALE override
 *
 * Hermetic: pure functions + a stubbed API object. No docker, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertNetTransition,
  buildNetPayload,
  canEnterNetState,
  deriveNetChecks,
  NET_CHECK_KEYS,
  NET_CHECK_VALUES,
  NET_PAYLOAD_KEYS,
} from '../../apps/api/src/services/redroid-health.js';
import { createToolHandlers } from '../../apps/worker/src/tool-helpers.js';
import { netCheckBadge, netStateBadge } from '../../apps/web/src/components/redroid-utils.js';

// ---------------------------------------------------------------------------
// The contract: NET_PAYLOAD_KEYS / NET_CHECK_KEYS / NET_CHECK_VALUES are
// exported by the service itself (redroid-health.js) — the single
// computation defines its own shape; the tests pin that the API, worker and
// UI boundaries all read exactly it (shared with
// tests/integration/r4-state-consistency.test.js).
// ---------------------------------------------------------------------------

const T0 = new Date('2026-10-20T10:00:00.000Z');

function row(over = {}) {
  return {
    netState: 'HEALTHY',
    netStateSince: T0,
    netCheckedAt: T0,
    netLastSuccessAt: T0,
    netConsecutiveFailures: 0,
    netLastErrorCode: null,
    netLastCanary: 'CANARY=PASS nonce=abcdef0123456789 ms=42',
    netRecoveries: 0,
    netLastRecoveryAt: null,
    netNextRecoveryAt: null,
    netManualIntervention: false,
    netRecoveryLockOwner: null,
    netRecoveryLockUntil: null,
    binaryState: 'ready',
    netLastChecks: {
      at: T0.toISOString(),
      container: 'PASS',
      binary: 'ready',
      process: 'alive',
      interface: 'up',
      routePolicy: 'enforced',
      effectiveRoute: 'tunnel',
      proxy: 'PASS',
      tcpCanary: 'PASS',
      canaryReason: null,
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Canonical shape (MD §6.2)
// ---------------------------------------------------------------------------

test('payload: key set is EXACTLY the MD §6.2 contract (no drift, no extras)', () => {
  const p = buildNetPayload(row(), { now: T0.getTime() + 1000, canaryConfigured: true });
  assert.deepEqual(Object.keys(p).sort(), [...NET_PAYLOAD_KEYS].sort());
  assert.deepEqual(Object.keys(p.checks).sort(), [...NET_CHECK_KEYS].sort());
  for (const v of Object.values(p.checks)) assert.ok(NET_CHECK_VALUES.includes(v), `check value ${v} outside vocabulary`);
});

test('payload: fresh HEALTHY → networkReady=true, all checks PASS, timestamps ISO', () => {
  const p = buildNetPayload(row(), { now: T0.getTime() + 1000, canaryConfigured: true });
  assert.equal(p.state, 'HEALTHY');
  assert.equal(p.stale, false);
  assert.equal(p.networkReady, true);
  assert.equal(p.consecutiveFailures, 0);
  assert.equal(p.lastErrorCode, null);
  assert.equal(p.checkedAt, T0.toISOString());
  assert.equal(p.lastSuccessAt, T0.toISOString());
  assert.equal(p.checks.tcpCanary, 'PASS');
  assert.equal(p.checks.routePolicy, 'PASS');
  assert.equal(p.checks.process, 'PASS');
  assert.equal(p.checks.interface, 'PASS');
  assert.equal(p.checks.binary, 'PASS');
});

test('payload: lastErrorCode empty string normalises to null (flat field, no junk)', () => {
  const p = buildNetPayload(row({ netLastErrorCode: '' }), { now: T0.getTime() + 1000 });
  assert.equal(p.lastErrorCode, null);
});

test('payload: recovery lock + nextRecoveryAt project (held vs expired)', () => {
  const until = new Date(T0.getTime() + 60_000);
  const p = buildNetPayload(
    row({ netRecoveryLockOwner: 'api-pid1234-host', netRecoveryLockUntil: until, netNextRecoveryAt: until }),
    { now: T0.getTime() + 1000 },
  );
  assert.equal(p.recoveryLock.held, true);
  assert.equal(p.recoveryLock.until, until.toISOString());
  assert.equal(p.nextRecoveryAt, until.toISOString());
  assert.ok(!JSON.stringify(p).includes('api-pid1234'), 'owner id must not be exposed (until+held are the contract)');

  const p2 = buildNetPayload(
    row({ netRecoveryLockOwner: 'api-pid1234-host', netRecoveryLockUntil: T0 }),
    { now: T0.getTime() + 1000 },
  );
  assert.equal(p2.recoveryLock.held, false, 'expired lease is not "held"');
});

// ---------------------------------------------------------------------------
// 2. Staleness — lastSuccessfulCheckAt expired ⇒ NOT permanently healthy
// ---------------------------------------------------------------------------

test('stale: aged last check (HEALTHY row, 120s old, 60s TTL) → stale=true + networkReady=false', () => {
  const p = buildNetPayload(row(), { now: T0.getTime() + 120_000, canaryConfigured: true });
  assert.equal(p.state, 'HEALTHY', 'the stored state is still reported (transparency)');
  assert.equal(p.stale, true);
  assert.equal(p.networkReady, false, 'a stale device must be treated as unhealthy');
});

test('stale: TTL is configurable (custom window honoured)', () => {
  const p = buildNetPayload(row(), { now: T0.getTime() + 30_000, staleTtlMs: 20_000 });
  assert.equal(p.stale, true);
  const p2 = buildNetPayload(row(), { now: T0.getTime() + 30_000, staleTtlMs: 60_000 });
  assert.equal(p2.stale, false);
});

test('deriveNetChecks: missing/malformed inputs degrade to UNKNOWN, never PASS (fail-closed)', () => {
  assert.deepEqual(deriveNetChecks(null), { binary: 'UNKNOWN', process: 'UNKNOWN', interface: 'UNKNOWN', routePolicy: 'UNKNOWN', tcpCanary: 'UNKNOWN' });
  assert.deepEqual(deriveNetChecks({}), { binary: 'UNKNOWN', process: 'UNKNOWN', interface: 'UNKNOWN', routePolicy: 'UNKNOWN', tcpCanary: 'UNKNOWN' });
  const malformed = deriveNetChecks({ binaryState: 'ready', netLastChecks: '{not-json' });
  assert.equal(malformed.binary, 'PASS', 'binary comes from row.binaryState independently of the stored JSON');
  assert.deepEqual(
    { process: malformed.process, interface: malformed.interface, routePolicy: malformed.routePolicy, tcpCanary: malformed.tcpCanary },
    { process: 'UNKNOWN', interface: 'UNKNOWN', routePolicy: 'UNKNOWN', tcpCanary: 'UNKNOWN' },
  );
});

test('deriveNetChecks: per-value mapping (alive/dead, up/down/missing, enforced/broken, PASS/FAIL/ERROR/SKIPPED)', () => {
  const base = { binaryState: 'ready' };
  const d = (over) => deriveNetChecks({ ...base, netLastChecks: { process: 'alive', interface: 'up', routePolicy: 'enforced', tcpCanary: 'PASS', ...over } });
  assert.equal(d({}).process, 'PASS');
  assert.equal(d({ process: 'dead' }).process, 'FAIL');
  assert.equal(d({ process: 'unknown' }).process, 'UNKNOWN');
  assert.equal(d({ interface: 'missing' }).interface, 'FAIL');
  assert.equal(d({ interface: 'down' }).interface, 'FAIL');
  assert.equal(d({ routePolicy: 'broken' }).routePolicy, 'FAIL');
  assert.equal(d({ tcpCanary: 'FAIL' }).tcpCanary, 'FAIL');
  assert.equal(d({ tcpCanary: 'ERROR' }).tcpCanary, 'FAIL', 'ERROR = not a pass');
  assert.equal(d({ tcpCanary: 'SKIPPED' }).tcpCanary, 'UNKNOWN', 'SKIPPED (not configured) is never displayed as a pass');
});

// ---------------------------------------------------------------------------
// 3. Transition guard — no blind HEALTHY, ever
// ---------------------------------------------------------------------------

test('guard: BLOCKED → HEALTHY has NO legal edge (duplicate/late event cannot overwrite)', () => {
  assert.equal(canEnterNetState('BLOCKED', 'HEALTHY'), false);
  assert.throws(() => assertNetTransition('BLOCKED', 'HEALTHY', {}), /illegal/);
  // even WITH canary evidence — the edge itself does not exist; HEALTHY is
  // reachable only via VERIFYING (the fresh-check path)
  assert.throws(
    () => assertNetTransition('BLOCKED', 'HEALTHY', { canary: { result: 'PASS', nonce: 'abcdef0123456789', at: Date.now() } }),
    /illegal/,
  );
  assert.throws(() => assertNetTransition('DEGRADED', 'HEALTHY', {}), /illegal/);
});

test('guard: VERIFYING → HEALTHY requires a FRESH canary PASS evidence object', () => {
  assert.throws(() => assertNetTransition('VERIFYING', 'HEALTHY', {}), /canary/);
  assert.throws(() => assertNetTransition('VERIFYING', 'HEALTHY', { canary: { result: 'FAIL', nonce: 'abcdef0123456789', at: Date.now() } }), /canary/);
  assert.throws(() => assertNetTransition('VERIFYING', 'HEALTHY', { canary: { result: 'PASS', nonce: 'short', at: Date.now() } }), /canary/);
  const ok = assertNetTransition('VERIFYING', 'HEALTHY', { canary: { result: 'PASS', nonce: 'abcdef0123456789', at: Date.now() } });
  assert.equal(ok.ok, true);
});

test('guard: self-transitions are rejected (callers no-op instead of persisting)', () => {
  for (const s of ['HEALTHY', 'BLOCKED', 'FAILED', 'STOPPED']) {
    assert.throws(() => assertNetTransition(s, s, {}), /self-transition/);
  }
});

// ---------------------------------------------------------------------------
// 4. One fixture, three boundaries (API shape / worker / UI) — same schema
// ---------------------------------------------------------------------------

const CRED = 'topsecret-passw0rd';
const FORBIDDEN_FRAGS = [CRED, 'socks5://', 'proxy-a.example'];

async function boundaryConsistency(state, { stale = false, networkReady } = {}) {
  // THE fixture: what buildNetPayload (the single computation) emits.
  const p = buildNetPayload(
    row({ netState: state, netLastErrorCode: state === 'HEALTHY' ? null : 'CANARY_FAIL' }),
    {
      now: stale ? T0.getTime() + 120_000 : T0.getTime() + 1000,
      canaryConfigured: true,
    },
  );
  if (state !== 'HEALTHY') { p.networkReady = false; p.stale = false; }
  const ready = networkReady ?? (state === 'HEALTHY' && !stale);
  p.networkReady = ready;
  p.stale = stale;

  // (a) WORKER boundary — the tool handler projection (real handler code,
  // stubbed transport). The stub echoes the API view shape.
  const handlers = createToolHandlers({
    api: { redroidDeviceStatus: async () => ({ device: { id: 'dev-1', name: 'redroid-x', containerState: 'running', adbState: 'online', proxy: { network: p } } }) },
  });
  const wr = await handlers['redroid.get_device_status']({ device: 'redroid-x' });
  assert.equal(wr.ok, true);
  assert.equal(wr.result.network.state, p.state);
  assert.equal(wr.result.network.dispatch, ready ? 'ALLOWED' : 'BLOCKED', 'worker gate must equal networkReady');
  assert.ok(NET_CHECK_KEYS.every((k) => k in wr.result.network.checks), 'worker projection keeps all five checks');
  const wjs = JSON.stringify(wr);
  for (const f of FORBIDDEN_FRAGS) assert.ok(!wjs.includes(f), `worker result leaked '${f}'`);

  // (b) UI boundary — the badge derivations (real UI code).
  const badge = netStateBadge(p);
  assert.equal(badge.dispatch, ready ? 'ALLOWED' : 'BLOCKED', 'UI dispatch must equal networkReady');
  if (stale) assert.match(badge.label, /^STALE/, 'stale renders as STALE text, never green');
  else if (state === 'HEALTHY') assert.match(badge.label, /^HEALTHY/);
  for (const k of NET_CHECK_KEYS) {
    const cb = netCheckBadge(p.checks[k]);
    assert.ok(NET_CHECK_VALUES.includes(cb.label), `UI check badge '${cb.label}' outside vocabulary`);
  }

  // (c) API boundary — the payload itself carries the contract keys.
  assert.deepEqual(Object.keys(p).sort(), [...NET_PAYLOAD_KEYS].sort());
}

test('boundaries agree: HEALTHY fixture (API shape = worker projection = UI badge)', async () => {
  await boundaryConsistency('HEALTHY');
});

test('boundaries agree: BLOCKED fixture → every boundary says BLOCKED (worker BLOCKED, UI fail-closed text)', async () => {
  await boundaryConsistency('BLOCKED');
});

test('boundaries agree: stale HEALTHY fixture → every boundary treats it as NOT ready', async () => {
  await boundaryConsistency('HEALTHY', { stale: true, networkReady: false });
});
