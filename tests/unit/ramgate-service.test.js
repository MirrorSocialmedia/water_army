/**
 * RAM-G1 — createRamGate service (hermetic, fake redis + injected clock).
 *
 * The fake redis (tests/helpers/ramgate-fake-redis.js) emulates the six
 * Lua scripts 1:1 — including check-then-write inside one eval call and
 * dead-lease pruning. Real-server atomicity + TTL + concurrency are
 * proven by the env-gated real-redis test and the br-b6g integration.
 *
 * Scenarios covered here (map to G1 C1–C6 at unit level):
 *   C1 memory enough → admit
 *   C2 projected short → deny (no lease, no side effect)
 *   C3 concurrency → cap enforced under parallel admits
 *   C4 metrics missing/stale → deny (fail-closed)
 *   C5 boot failure → release (owner-checked)
 *   C6 worker kill → TTL expiry + reconcile (release + recovery)
 *   C7 stop-new semantics (cap denies while existing leases persist)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRamGate,
  RAM_GATE_REASON,
  RAM_GATE_ENV,
  RAM_GATE_DEFAULTS,
} from '@water-army/shared';
import { makeFakeRamRedis } from '../helpers/ramgate-fake-redis.js';

/** Deterministic gate harness with a controllable clock + metrics. */
function harness({ memAvailableMiB = 30_000, now = 1_000_000, env = {}, metricsError = null, configSource = null, sampleTsOffset = 0 } = {}) {
  let clock = now;
  const advance = (ms) => {
    clock += ms;
  };
  const redis = makeFakeRamRedis({ now: () => clock });
  const metrics = {
    async sample() {
      if (metricsError) throw metricsError;
      return {
        ts: clock + sampleTsOffset,
        memAvailableMiB,
        memTotalMiB: 94_000,
        memFreeMiB: 2_500,
        swapTotalMiB: 8192,
        swapFreeMiB: 8100,
        loadAvg: [1, 1, 1],
        source: 'fake',
      };
    },
  };
  const decisions = [];
  const gate = createRamGate({
    redis,
    metrics,
    configSource,
    env,
    now: () => clock,
    decisionSink: (d) => {
      decisions.push(d);
    },
    log: { warn() {}, error() {}, info() {} },
  });
  return { gate, redis, decisions, advance, getClock: () => clock };
}

// Each test builds its own harness (deterministic clock per test).

test('C1 unit — memory enough → admit (lease created, count visible)', async () => {
  const h = harness();
  const r = await h.gate.admit({ kind: 'device', entityKey: 'dev-1', entityName: 'dev-1', source: 'test' });
  assert.equal(r.admitted, true);
  assert.equal(r.reason, RAM_GATE_REASON.ADMITTED);
  assert.ok(r.admissionId);
  assert.equal(r.liveCount, 1);
  assert.equal(r.projectedMiB, 28_800);
  assert.equal(await h.gate.liveCount(), 1);
  const leases = await h.gate.listLeases();
  assert.equal(leases.length, 1);
  assert.equal(leases[0].value.e, 'dev-1');
  assert.equal(leases[0].value.k, 'device');
  // decision logged
  assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0].action, 'admit');
});

test('C2 unit — projected short → deny, zero side effects', async () => {
  const h = harness({ memAvailableMiB: 20_000 }); // 20000 − 1×1200 = 18800 ≥ 18432 → still admits!
  const r1 = await h.gate.admit({ kind: 'device', entityKey: 'a' });
  assert.equal(r1.admitted, true);
  // now 1 live: 20000 − 2×1200 = 17600 < 18432 → the 2nd must be denied
  const r2 = await h.gate.admit({ kind: 'device', entityKey: 'b' });
  assert.equal(r2.admitted, false);
  assert.equal(r2.reason, RAM_GATE_REASON.PROJECTED_BELOW_TARGET);
  assert.equal(r2.projectedMiB, 17_600);
  assert.equal(await h.gate.liveCount(), 1); // b never reserved
  assert.equal((await h.gate.listLeases()).length, 1);
  assert.equal(h.decisions.at(-1).action, 'deny');
  assert.equal(h.decisions.at(-1).reason, 'PROJECTED_BELOW_TARGET');
});

test('C3 unit — parallel admits never exceed the cap (fake-redis atomicity stand-in)', async () => {
  // 31,000 MiB: the 10th boot's projection = 31000 − 10×1200 = 19000 ≥ 18432,
  // so the CAP (not the projection) is the binding constraint at 10.
  const h = harness({ memAvailableMiB: 31_000 });
  const N = 15;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => h.gate.admit({ kind: 'device', entityKey: `p${i}` })),
  );
  const admitted = results.filter((r) => r.admitted).length;
  assert.equal(admitted, 10); // MAX_PARALLEL
  assert.equal(await h.gate.liveCount(), 10);
  // every denial is the cap itself (projection never binds at 31,000)
  const denials = results.filter((r) => !r.admitted);
  assert.equal(denials.length, 5);
  assert.ok(denials.every((r) => r.reason === RAM_GATE_REASON.MAX_PARALLEL));
});

test('C3 unit — projection binds before the cap (30,000 MiB admits 9, not 10)', async () => {
  const h = harness({ memAvailableMiB: 30_000 });
  const results = await Promise.all(
    Array.from({ length: 15 }, (_, i) => h.gate.admit({ kind: 'device', entityKey: `q${i}` })),
  );
  const admitted = results.filter((r) => r.admitted).length;
  assert.equal(admitted, 9); // 30000 − 10×1200 = 18000 < 18432 → 10th projected-denied
  const denials = results.filter((r) => !r.admitted);
  assert.ok(denials.every((r) => ['MAX_PARALLEL', 'PROJECTED_BELOW_TARGET'].includes(r.reason)));
});

test('C3 unit — self-renewal: a retrying entity re-admits AT the cap (no self-deadlock)', async () => {
  const h = harness({ memAvailableMiB: 31_000 });
  const a = await h.gate.admit({ kind: 'run', entityKey: 'run-retry' });
  assert.ok(a.admitted);
  // fill to the cap with 9 OTHER entities
  for (let i = 0; i < 9; i += 1) {
    await h.gate.admit({ kind: 'run', entityKey: `other-${i}` });
  }
  assert.equal(await h.gate.liveCount(), 10); // cap reached
  // a NEW entity must be denied…
  const fresh = await h.gate.admit({ kind: 'run', entityKey: 'fresh' });
  assert.equal(fresh.admitted, false);
  assert.equal(fresh.reason, RAM_GATE_REASON.MAX_PARALLEL);
  // …but the retrying entity re-admits (its own lease is a renewal)
  const retry = await h.gate.admit({ kind: 'run', entityKey: 'run-retry' });
  assert.equal(retry.admitted, true);
  assert.equal(await h.gate.liveCount(), 10); // still exactly the cap — no 11th
});

test('C4 unit — stale metrics → deny METRICS_STALE (fail-closed)', async () => {
  const h = harness({ sampleTsOffset: -31_000 }); // sample is 31s old (> 30s max)
  const r = await h.gate.admit({ kind: 'device', entityKey: 'stale' });
  assert.equal(r.admitted, false);
  assert.equal(r.reason, RAM_GATE_REASON.METRICS_STALE);
  assert.equal(await h.gate.liveCount(), 0);
});

test('C4 unit — metrics provider throws → deny METRICS_UNAVAILABLE', async () => {
  const h = harness({ metricsError: new Error('proc read boom') });
  const r = await h.gate.admit({ kind: 'device', entityKey: 'x' });
  assert.equal(r.admitted, false);
  assert.equal(r.reason, RAM_GATE_REASON.METRICS_UNAVAILABLE);
  assert.match(r.details.error, /proc read boom/);
});

test('C4 unit — redis eval failure → deny STORE_UNAVAILABLE (fail-closed)', async () => {
  const h = harness();
  h.redis.__failEval('connection lost');
  const r = await h.gate.admit({ kind: 'device', entityKey: 'x' });
  assert.equal(r.admitted, false);
  assert.equal(r.reason, RAM_GATE_REASON.STORE_UNAVAILABLE);
});

test('C5 unit — release is owner-checked: wrong admissionId is a no-op, correct frees the slot', async () => {
  const h = harness();
  const a = await h.gate.admit({ kind: 'device', entityKey: 'd1' });
  assert.ok(a.admitted);
  // boot fails before the device exists → the caller releases
  const wrong = await h.gate.release({ kind: 'device', entityKey: 'd1', admissionId: 'not-the-id', reason: 'boot-fail' });
  assert.equal(wrong.released, false);
  assert.equal(await h.gate.liveCount(), 1);
  const right = await h.gate.release({ kind: 'device', entityKey: 'd1', admissionId: a.admissionId, reason: 'boot-fail' });
  assert.equal(right.released, true);
  assert.equal(await h.gate.liveCount(), 0);
  // slot reusable immediately
  const again = await h.gate.admit({ kind: 'device', entityKey: 'd1' });
  assert.equal(again.admitted, true);
  assert.notEqual(again.admissionId, a.admissionId);
});

test('C6 unit — TTL expiry prunes dead leases (worker killed, no release)', async () => {
  const h = harness({ env: { [RAM_GATE_ENV.leaseTtlMs]: '60000' } });
  const a = await h.gate.admit({ kind: 'device', entityKey: 'killer' });
  assert.ok(a.admitted);
  h.advance(61_000); // lease expired (fake clock drives lazy expiry)
  // the next admission prunes the dead lease and succeeds
  const b = await h.gate.admit({ kind: 'device', entityKey: 'after' });
  assert.equal(b.admitted, true);
  assert.equal(b.liveCount, 1); // the dead one was pruned, not counted
  assert.equal(await h.gate.liveCount(), 1);
});

test('C6 unit — reconcile: stale lease released, live entity renewed, missing lease recovered', async () => {
  const h = harness();
  const states = new Map();
  // gate with entityState/expectedEntities wired for reconciliation
  const gate = createRamGate({
    redis: h.redis,
    metrics: { sample: async () => ({ ts: h.getClock(), memAvailableMiB: 30_000, source: 'fake' }) },
    env: {},
    now: h.getClock,
    entityState: async (v) => states.get(`${v.k}:${v.e}`) ?? 'gone',
    expectedEntities: async () => {
      const out = [];
      for (const [k, st] of states) {
        if (st !== 'gone') {
          const [kind, e] = k.split(':');
          out.push({ kind, entityKey: e });
        }
      }
      return out;
    },
    log: { warn() {}, error() {}, info() {} },
  });

  // lease 1: entity GONE (device deleted without release — crash path)
  const a = await gate.admit({ kind: 'device', entityKey: 'gone-dev' });
  assert.ok(a.admitted);
  // lease 2: entity still BOOTING
  const b = await gate.admit({ kind: 'device', entityKey: 'boot-dev' });
  assert.ok(b.admitted);
  states.set('device:gone-dev', 'gone');
  states.set('device:boot-dev', 'booting');
  states.set('device:recovered-dev', 'running'); // entitled but no lease yet

  const s = await gate.reconcile();
  assert.deepEqual(s.released, ['device:gone-dev']);
  assert.equal(s.renewed, 1); // boot-dev
  assert.equal(s.recovered, 1); // recovered-dev
  assert.equal(s.errors.length, 0, JSON.stringify(s.errors));
  assert.equal(await gate.liveCount(), 2); // boot-dev + recovered-dev
  const keys = (await gate.listLeases()).map((l) => l.value.e).sort();
  assert.deepEqual(keys, ['boot-dev', 'recovered-dev']);
});

test('C7 unit — below admission line: cap denies NEW boots, existing leases untouched', async () => {
  const h = harness({ memAvailableMiB: 25_000 });
  // fill to the cap
  const admits = [];
  for (let i = 0; i < 10; i += 1) admits.push(await h.gate.admit({ kind: 'device', entityKey: `hold-${i}` }));
  const admittedCount = admits.filter((r) => r.admitted).length;
  assert.ok(admittedCount >= 1); // at least the first fits
  const live = await h.gate.liveCount();
  // a fresh boot must be denied while pressure persists
  const next = await h.gate.admit({ kind: 'device', entityKey: 'intruder' });
  assert.equal(next.admitted, false);
  assert.ok(['MAX_PARALLEL', 'BELOW_HARD_FLOOR', 'PROJECTED_BELOW_TARGET'].includes(next.reason));
  // existing leases are NOT touched (no auto-kill / no auto-release)
  assert.equal(await h.gate.liveCount(), live);
  assert.equal((await h.gate.listLeases()).length, live);
});

test('disabled gate — RAM_GATE_ENABLED=false bypasses (labelled GATE_DISABLED)', async () => {
  const h = harness({ env: { [RAM_GATE_ENV.enabled]: 'false' } });
  const r = await h.gate.admit({ kind: 'device', entityKey: 'bypass' });
  assert.equal(r.admitted, true);
  assert.equal(r.reason, RAM_GATE_REASON.GATE_DISABLED);
  assert.equal(r.bypass, true);
  assert.equal(await h.gate.liveCount(), 0); // nothing reserved
});

test('invalid config — fail closed (CONFIG_INVALID deny, not default-allow)', async () => {
  const h = harness({ env: { [RAM_GATE_ENV.maxParallel]: '0' } });
  const r = await h.gate.admit({ kind: 'device', entityKey: 'x' });
  assert.equal(r.admitted, false);
  assert.equal(r.reason, RAM_GATE_REASON.CONFIG_INVALID);
  assert.ok(r.details.errors.length > 0);
});

test('status() — full payload shape (metrics + config + counts + wouldAdmitNext + store)', async () => {
  const h = harness();
  await h.gate.admit({ kind: 'device', entityKey: 's1' });
  const st = await h.gate.status();
  assert.equal(st.enabled, true);
  assert.equal(st.config.maxParallel, 10);
  assert.equal(st.metrics.ok, true);
  assert.equal(st.metrics.memAvailableMiB, 30_000);
  assert.equal(st.metrics.stale, false);
  assert.equal(st.counts.liveLeases, 1);
  assert.equal(st.counts.reservedMiB, RAM_GATE_DEFAULTS.perBootBudgetMiB);
  assert.equal(st.counts.running, null); // no runningCount provider
  assert.equal(st.store.redis, true);
  assert.equal(st.wouldAdmitNext.admitted, true);
  assert.equal(st.wouldAdmitNext.liveCount, 1);
  assert.equal(st.wouldAdmitNext.projectedMiB, 27_600); // 30000 − 2×1200
});

test('releaseByKey — authority path (reconciler / stop without admissionId)', async () => {
  const h = harness();
  const a = await h.gate.admit({ kind: 'run', entityKey: 'run-1' });
  assert.ok(a.admitted);
  const r = await h.gate.releaseByKey({ kind: 'run', entityKey: 'run-1', reason: 'stop-action' });
  assert.equal(r.released, true);
  assert.equal(r.value.a, a.admissionId);
  assert.equal(await h.gate.liveCount(), 0);
  const again = await h.gate.releaseByKey({ kind: 'run', entityKey: 'run-1' });
  assert.equal(again.released, false);
});
