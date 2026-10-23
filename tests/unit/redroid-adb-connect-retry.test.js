/**
 * P3 boot-ladder finding (2026-10-23) — regression test for the adb
 * one-shot-connect gap in the provision boot wait.
 *
 * The t0 `adb connect` fires BEFORE adbd inside the container is listening;
 * without a per-poll retry the `-s <serial>` getprop polls can never reach
 * the (never-registered) serial and a healthy boot was on track for a
 * spurious REDROID_TUNNEL_BOOT_TIMEOUT. All five scratch ladder devices
 * (s2–s5) sat 'offline' until a manual `adb connect` landed.
 *
 * Hermetic: fake adb engine, millisecond polls, no real adb/docker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForAdbBootCompleted } from '../../apps/api/src/services/redroid-service.js';

/**
 * Fake adb engine that models the real-world sequence:
 *  - `connect` always "succeeds" (idempotent op) but only REGISTERS the
 *    serial on the Nth call (adbd comes up mid-boot);
 *  - `getprop` fails ("device not found") until the serial is registered,
 *    then returns '1' (booted).
 */
function fakeEngine({ registerOnConnect = 3 } = {}) {
  const ops = [];
  let registered = false;
  let connects = 0;
  return {
    ops,
    async run({ op, target }) {
      ops.push(op);
      if (op === 'connect') {
        connects += 1;
        if (connects >= registerOnConnect) registered = true;
        return { exitCode: 0, stdout: registered ? 'already connected to ' + target : 'connected to ' + target, stderr: '', timedOut: false };
      }
      if (op === 'getprop') {
        if (!registered) return { exitCode: 1, stdout: `error: device '${target}' not found`, stderr: '', timedOut: false };
        return { exitCode: 0, stdout: '1', stderr: '', timedOut: false };
      }
      throw new Error('unexpected op ' + op);
    },
  };
}

test('boot wait: t0 connect misses, per-poll retry registers the serial, boot detected', async () => {
  const engine = fakeEngine({ registerOnConnect: 3 }); // first two connects (t0 + poll1) miss
  const { booted } = await waitForAdbBootCompleted({
    adbEngine: engine,
    target: '127.0.0.1:16599',
    deadline: Date.now() + 2_000,
    pollMs: 10,
  });
  assert.equal(booted, true);
  // the connect must have retried until the registration happened:
  const connects = engine.ops.filter((o) => o === 'connect').length;
  const getprops = engine.ops.filter((o) => o === 'getprop').length;
  assert.ok(connects >= 3, `expected >=3 connects (got ${connects}) — the retry is the whole fix`);
  assert.ok(getprops >= 2, `expected the failing getprop before the success (got ${getprops})`);
  // a connect precedes the final (successful) getprop:
  const lastGetprop = engine.ops.lastIndexOf('getprop');
  assert.ok(engine.ops.slice(0, lastGetprop).includes('connect'));
});

test('boot wait: no boot before deadline → booted=false but connects kept retrying', async () => {
  const engine = fakeEngine({ registerOnConnect: 999 }); // adbd never comes up
  const { booted } = await waitForAdbBootCompleted({
    adbEngine: engine,
    target: '127.0.0.1:16598',
    deadline: Date.now() + 120,
    pollMs: 20,
  });
  assert.equal(booted, false);
  const connects = engine.ops.filter((o) => o === 'connect').length;
  assert.ok(connects >= 4, `expected repeated connect retries until the deadline (got ${connects})`);
});

test('boot wait: engine validation error exits the loop (no infinite spin)', async () => {
  const ops = [];
  const engine = {
    async run({ op }) {
      ops.push(op);
      if (op === 'getprop') throw new Error('whitelist: op rejected');
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
  };
  const { booted } = await waitForAdbBootCompleted({
    adbEngine: engine,
    target: '127.0.0.1:16597',
    deadline: Date.now() + 5_000,
    pollMs: 10,
  });
  assert.equal(booted, false);
  assert.ok(ops.filter((o) => o === 'getprop').length <= 1, 'must not spin on a validation error');
});

test('boot wait: timed-out getprop is not a success (keeps polling)', async () => {
  let n = 0;
  const ops = [];
  const engine = {
    async run({ op }) {
      ops.push(op);
      if (op === 'getprop') {
        n += 1;
        if (n === 1) return { exitCode: 0, stdout: '', stderr: '', timedOut: true }; // hung adb
        return { exitCode: 0, stdout: '1', stderr: '', timedOut: false };
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
  };
  const { booted } = await waitForAdbBootCompleted({
    adbEngine: engine,
    target: '127.0.0.1:16596',
    deadline: Date.now() + 2_000,
    pollMs: 10,
  });
  assert.equal(booted, true);
  assert.ok(ops.filter((o) => o === 'getprop').length >= 2, 'the timed-out poll must be retried');
});
