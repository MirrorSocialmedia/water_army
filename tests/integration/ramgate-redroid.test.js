/**
 * RAM-G1 — redroid device path gate wiring (hermetic, mock redroid env).
 *
 * The REAL createRedroidService (mock adapter) wired with the REAL gate
 * (fake redis implementing the exact Lua semantics + injected metrics).
 * Proves the INSERTION CONTRACT at the HTTP level:
 *   - create: admit BEFORE data dir / DB row / docker create; denial = 409
 *     RAM_GATE_DENIED with ZERO side effects
 *   - stop: lease released; start: re-admits; restart: renews (no double
 *     count); delete: released
 *   - floor / projection / metrics-failure denials flow to the error
 *     envelope with the stable reason code
 *   - the status/decisions surface reflects every step (C8 consistency)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeRedroidTestApp, login, seedRedroidTemplates, SEED_TEMPLATES } from '../helpers/redroid-fakes.js';
import { makeFakeRamRedis } from '../helpers/ramgate-fake-redis.js';
import { fakeRedisOk } from '../helpers/fakes.js';

function makeGateWorld() {
  const state = { memAvailableMiB: 30_000, fail: null, staleMs: 0 };
  const metrics = {
    sample: async () => {
      if (state.fail) throw state.fail;
      return {
        ts: Date.now() - state.staleMs,
        memAvailableMiB: state.memAvailableMiB,
        memTotalMiB: 94_000,
        memFreeMiB: 2_500,
        swapTotalMiB: 8192,
        swapFreeMiB: 8_100,
        loadAvg: [1, 1, 1],
        source: 'fake-gate-test',
      };
    },
  };
  const gateRedis = { ...fakeRedisOk(), ...makeFakeRamRedis() };
  return { state, metrics, gateRedis };
}

async function makeApp({ redroidMockOpts = {} } = {}) {
  const gw = makeGateWorld();
  const { app, db, dataRoot, redroidMock } = await makeRedroidTestApp({
    redroidMockOpts,
    extraAppOpts: { redis: gw.gateRedis, ramGateMetrics: gw.metrics },
  });
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  await seedRedroidTemplates(app, admin);
  const status = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/ram-gate', headers: { cookie: admin } });
    assert.equal(res.statusCode, 200, `ram-gate status: ${res.body}`);
    return res.json();
  };
  const decisions = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/ram-gate/decisions?limit=50', headers: { cookie: admin } });
    assert.equal(res.statusCode, 200, `decisions: ${res.body}`);
    return res.json().decisions;
  };
  const close = async () => {
    await app.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  };
  return { app, db, dataRoot, redroidMock, admin, operator, state: gw.state, status, decisions, close };
}

test('RAM-G1 redroid — C1: memory enough → create admitted, lease held, decision logged', async (t) => {
  const { app, admin, status, decisions, close } = await makeApp();
  t.after(close);

  const res = await app.inject({
    method: 'POST',
    url: '/api/devices/redroid',
    headers: { cookie: admin },
    payload: { name: 'redroid-g1-a', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-001' },
  });
  assert.equal(res.statusCode, 201, `create: ${res.body}`);

  const st = await status();
  assert.equal(st.enabled, true);
  assert.equal(st.counts.liveLeases, 1, 'one device lease after create');
  assert.equal(st.counts.reservedMiB, 1200);
  const d = (await decisions()).find((x) => x.action === 'admit' && x.entity === 'redroid-g1-a');
  assert.ok(d, 'admission decision recorded');
  assert.equal(d.reason, 'ADMITTED');
  assert.equal(d.source, 'redroid-create');
});

test('RAM-G1 redroid — C2: projected below target → 409 RAM_GATE_DENIED, zero side effects', async (t) => {
  const { app, db, dataRoot, admin, state, status, decisions, close } = await makeApp();
  t.after(close);

  const r1 = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name: 'redroid-g1-b1', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-011' },
  });
  assert.equal(r1.statusCode, 201, `first create: ${r1.body}`);

  // 1 live lease; drop MemAvailable so the 2nd boot's projection fails:
  // projected = 18000 − 2×1200 = 15600 < 18432 (floor 16384 still above)
  state.memAvailableMiB = 18_000;
  const r2 = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name: 'redroid-g1-b2', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-012' },
  });
  assert.equal(r2.statusCode, 409, `denied create: ${r2.body}`);
  assert.equal(r2.json().error.code, 'RAM_GATE_DENIED');
  assert.match(r2.json().error.message, /PROJECTED_BELOW_TARGET/);

  // ZERO side effects: no data dir, no DB row, no docker create
  assert.equal(fs.existsSync(path.join(dataRoot, 'redroid-g1-b2')), false, 'no data dir on denial');
  assert.equal(await db.device.findUnique({ where: { name: 'redroid-g1-b2' } }), null, 'no device row on denial');
  const st = await status();
  assert.equal(st.counts.liveLeases, 1, 'no lease for the denied device');
  const deny = (await decisions()).find((x) => x.action === 'deny' && x.entity === 'redroid-g1-b2');
  assert.equal(deny?.reason, 'PROJECTED_BELOW_TARGET');
});

test('RAM-G1 redroid — C7: below the hard floor → 409 BELOW_HARD_FLOOR', async (t) => {
  const { app, admin, state, decisions, close } = await makeApp();
  t.after(close);
  state.memAvailableMiB = 15_000; // < 16384 floor
  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name: 'redroid-g1-c', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-021' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'RAM_GATE_DENIED');
  assert.match(res.json().error.message, /BELOW_HARD_FLOOR/);
  const deny = (await decisions()).find((x) => x.action === 'deny' && x.entity === 'redroid-g1-c');
  assert.equal(deny?.reason, 'BELOW_HARD_FLOOR');
});

test('RAM-G1 redroid — C4: metrics provider failure → 409 METRICS_UNAVAILABLE (fail-closed)', async (t) => {
  const { app, admin, state, decisions, close } = await makeApp();
  t.after(close);
  state.fail = new Error('proc read boom');
  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name: 'redroid-g1-d', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-031' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'RAM_GATE_DENIED');
  assert.match(res.json().error.message, /METRICS_UNAVAILABLE/);
  const deny = (await decisions()).find((x) => x.action === 'deny' && x.entity === 'redroid-g1-d');
  assert.equal(deny?.reason, 'METRICS_UNAVAILABLE');
});

test('RAM-G1 redroid — C4: stale sample → 409 METRICS_STALE (fail-closed)', async (t) => {
  const { app, admin, state, decisions, close } = await makeApp();
  t.after(close);
  state.staleMs = 31_000; // sample 31s old > 30s max age
  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name: 'redroid-g1-e', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-041' },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error.message, /METRICS_STALE/);
  const deny = (await decisions()).find((x) => x.action === 'deny' && x.entity === 'redroid-g1-e');
  assert.equal(deny?.reason, 'METRICS_STALE');
});

test('RAM-G1 redroid — lease lifecycle: stop releases, start re-admits, restart renews (no double count)', async (t) => {
  const { app, admin, status, close } = await makeApp();
  t.after(close);
  const create = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name: 'redroid-g1-f', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-051' },
  });
  assert.equal(create.statusCode, 201, create.body);
  assert.equal((await status()).counts.liveLeases, 1);

  // restart — the lease must NOT double
  const rr = await app.inject({ method: 'POST', url: '/api/devices/redroid/redroid-g1-f/restart', headers: { cookie: admin } });
  assert.equal(rr.statusCode, 200, rr.body);
  assert.equal((await status()).counts.liveLeases, 1, 'restart renews — still one lease');

  // stop — released
  const stop = await app.inject({ method: 'POST', url: '/api/devices/redroid/redroid-g1-f/stop', headers: { cookie: admin } });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal((await status()).counts.liveLeases, 0, 'stop releases the lease');

  // start — re-admits fresh
  const start = await app.inject({ method: 'POST', url: '/api/devices/redroid/redroid-g1-f/start', headers: { cookie: admin } });
  assert.equal(start.statusCode, 200, start.body);
  assert.equal((await status()).counts.liveLeases, 1, 'start re-admits');
});

test('RAM-G1 redroid — delete releases the lease; wouldAdmitNext reflects the fleet', async (t) => {
  const { app, admin, status, close } = await makeApp();
  t.after(close);
  await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name: 'redroid-g1-g', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-061' },
  });
  let st = await status();
  assert.equal(st.counts.liveLeases, 1);
  assert.equal(st.wouldAdmitNext.admitted, true);

  const del = await app.inject({ method: 'DELETE', url: '/api/devices/redroid/redroid-g1-g', headers: { cookie: admin }, payload: { confirm: 'redroid-g1-g' } });
  assert.equal(del.statusCode, 200, del.body);
  st = await status();
  assert.equal(st.counts.liveLeases, 0, 'delete releases the lease');
});

test('RAM-G1 redroid — C5: docker create fails AFTER admission → rollback releases the lease (no budget leak)', async (t) => {
  const {
    app, db, dataRoot, redroidMock, admin, status, decisions, close,
  } = await makeApp({
    redroidMockOpts: { createError: { statusCode: 500, message: 'driver failed: storage driver error (simulated)' } },
  });
  t.after(close);

  const res = await app.inject({
    method: 'POST', url: '/api/devices/redroid', headers: { cookie: admin },
    payload: { name: 'redroid-g1-h', templateName: SEED_TEMPLATES[1].name, idempotencyKey: 'g1-ik-071' },
  });
  assert.notEqual(res.statusCode, 201, `failed create must not succeed: ${res.body}`);

  // The admission DID happen (decision trail) — the release must undo it.
  const admit = (await decisions()).find((x) => x.action === 'admit' && x.entity === 'redroid-g1-h');
  assert.ok(admit, 'admission decision recorded before the docker failure');
  assert.equal(admit.reason, 'ADMITTED');

  const st = await status();
  assert.equal(st.counts.liveLeases, 0, 'rollback released the admission lease — no budget leak');
  assert.equal(st.counts.reservedMiB, 0);

  // Full rollback: no DB row, no data dir, no dangling container.
  assert.equal(await db.device.findUnique({ where: { name: 'redroid-g1-h' } }), null, 'no device row after rollback');
  assert.equal(fs.existsSync(path.join(dataRoot, 'redroid-g1-h')), false, 'data dir removed on rollback');
  assert.equal(redroidMock.docker.client.__byName.get('redroid-g1-h') ?? null, null, 'no dangling container after rollback');
});
