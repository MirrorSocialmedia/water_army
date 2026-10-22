/**
 * Regression test — P1-fix (2026-10-14): BullMQ 6 RedisConnection only
 * honours a `url` key. Passing a bare `redis://...` string gets
 * Object.assign'd into char-index keys, so the connection silently falls
 * back to 127.0.0.1:6379. The worker ECONNREFUSED-looped for 3h while
 * REDIS_URL was correct; the "5/5 healthy" P1 delivery claim was false.
 *
 * Two layers of protection:
 *  1. createBullMqWorker (injectable fake Worker ctor) MUST receive
 *     `connection` as `{ url }` — a regression to a bare string fails here.
 *  2. Real bullmq RedisConnection contrast (hermetic via clientFactory):
 *     documents that the string form normalizes to host 127.0.0.1 while the
 *     `{ url }` form is preserved — i.e. this test would also catch a
 *     future BullMQ that suddenly accepts strings by pinning current behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildRedisConnection } from '@water-army/shared';
import { RedisConnection } from 'bullmq/dist/cjs/classes/redis-connection.js';
import { createBullMqWorker } from '../../apps/worker/src/worker.js';

const REDIS_URL = 'redis://redis:6379';

function makeConfig(overrides = {}) {
  return { redisUrl: REDIS_URL, taskMaxConcurrency: 2, ...overrides };
}

// ---- Layer 1: worker passes { url } to the BullMQ Worker ctor ----------

class FakeWorker extends EventEmitter {
  static instances = [];
  constructor(queueName, processor, opts) {
    super();
    this.queueName = queueName;
    this.processor = processor;
    this.opts = opts;
    FakeWorker.instances.push(this);
  }
  async close() {}
}

test('createBullMqWorker passes connection as { url } — never a bare string', () => {
  const worker = createBullMqWorker(makeConfig(), { Worker: FakeWorker });

  const { connection, concurrency } = worker.opts;
  assert.equal(worker.queueName, 'ai-tasks');
  assert.equal(concurrency, 2);
  // The regression: a bare string here silently falls back to 127.0.0.1:6379.
  assert.notEqual(typeof connection, 'string', 'connection must not be a bare redis:// string');
  assert.deepEqual(connection, { url: REDIS_URL });
});

test('createBullMqWorker rejects malformed REDIS_URL loudly (no silent 127.0.0.1 fallback)', () => {
  assert.throws(
    () => createBullMqWorker(makeConfig({ redisUrl: 'redis:6379-no-scheme' }), { Worker: FakeWorker }),
    TypeError,
  );
});

// ---- Layer 0: the shared helper itself ----------------------------------

test('buildRedisConnection returns { url } and rejects non-URL input', () => {
  assert.deepEqual(buildRedisConnection(REDIS_URL), { url: REDIS_URL });
  assert.deepEqual(buildRedisConnection('rediss://redis:6380'), { url: 'rediss://redis:6380' });
  assert.throws(() => buildRedisConnection('redis:6379'), TypeError);
  assert.throws(() => buildRedisConnection(''), TypeError);
  assert.throws(() => buildRedisConnection(null), TypeError);
});

// ---- BR-B6: slot-defer completion-artifact demotion ---------------------
// The batch engine's sanctioned slot-defer path parks the job in DELAYED
// from inside the processor; BullMQ's completion handling then surfaces a
// PAIR of events per deferral ('Job ... is not in the active state.
// moveToFinished' + 'Missing lock for job ...' — exact pairs observed in
// E2E run-4/run-5: 468k error lines per run). createBullMqWorker budgets
// two demotions per tracked job id; anything over budget stays at error.

test('createBullMqWorker: deferral artifacts demote to debug; over-budget and untracked errors stay at error level', () => {
  const events = [];
  const fakeLog = {
    info() {},
    warn(o) { events.push(['warn', o]); },
    error: (o) => events.push(['error', o]),
    debug: (o) => events.push(['debug', o]),
  };
  const tracker = { budget: new Map([['batch-1111-1', 2]]) };
  const worker = createBullMqWorker(makeConfig(), { Worker: FakeWorker, log: fakeLog, deferTracker: tracker });

  // The observed artifact pair for a tracked job id → both demoted:
  worker.emit('error', new Error('Job batch-1111-1 is not in the active state. moveToFinished'));
  worker.emit('error', new Error('Missing lock for job batch-1111-1. moveToFinished'));
  // Budget exhausted — a THIRD same-id error is a real error again:
  worker.emit('error', new Error('Job batch-1111-1 is not in the active state. moveToFinished'));

  // 'failed' form with job.id, budget pre-marked as the processor would —
  // the observed artifact pair arrives as two events:
  tracker.budget.set('batch-2222-2', 2);
  worker.emit('failed', { id: 'batch-2222-2', data: {} }, new Error('Job batch-2222-2 is not in the active state. moveToFinished'));
  worker.emit('failed', { id: 'batch-2222-2', data: {} }, new Error('Missing lock for job batch-2222-2. moveToFinished'));
  // Untracked id → never demoted, stays warn (the real failure path):
  worker.emit('failed', { id: 'batch-3333-3', data: {} }, new Error('boom'));

  // Genuine worker error (no job id at all) → stays error:
  worker.emit('error', new Error('ECONNREFUSED 127.0.0.1:16342'));

  assert.deepEqual(
    events.map((e) => e[0]),
    ['debug', 'debug', 'error', 'debug', 'debug', 'warn', 'error'],
    'artifact pair demoted, over-budget error surfaced, untracked failed stays warn, real worker error stays error',
  );
  assert.equal(tracker.budget.size, 0, 'both budgets fully consumed');
});

test('createBullMqWorker without deferTracker: every error/failed surfaces at full level (default path unchanged)', () => {
  const events = [];
  const fakeLog = {
    info() {},
    warn(o) { events.push(['warn', o]); },
    error: (o) => events.push(['error', o]),
    debug: (o) => events.push(['debug', o]),
  };
  const worker = createBullMqWorker(makeConfig(), { Worker: FakeWorker, log: fakeLog });

  worker.emit('error', new Error('Job batch-9999-9 is not in the active state. moveToFinished'));
  worker.emit('failed', { id: 'batch-9999-9', data: {} }, new Error('Job batch-9999-9 is not in the active state. moveToFinished'));

  assert.deepEqual(events.map((e) => e[0]), ['error', 'warn'], 'no tracker → nothing is demoted');
});

// ---- Layer 2: real RedisConnection behavior contrast (documented trap) --

function makeFakeClient() {
  // init() needs: on(), defineCommand() (loadCommands), status === 'end'
  // (skips the version check). No network, ever.
  const client = new EventEmitter();
  client.status = 'end';
  client.defineCommand = () => {};
  return client;
}

test('bullmq RedisConnection: string form falls back to 127.0.0.1, { url } form is preserved', async (t) => {
  let captured;
  RedisConnection.clientFactory = (opts) => {
    captured = opts;
    return makeFakeClient();
  };
  t.after(() => {
    RedisConnection.clientFactory = undefined;
  });

  // The trap: bare string → Object.assign char-index keys → defaults win.
  const fromString = new RedisConnection(REDIS_URL, { skipWaitingForReady: true });
  await fromString.initializing;
  assert.equal(fromString.opts.url, undefined, 'string form must NOT produce a url key');
  assert.equal(fromString.opts.host, '127.0.0.1', 'documented trap: string form falls back to loopback');
  assert.equal(captured.host, '127.0.0.1', 'the underlying client would have connected to loopback');

  // The fix: { url } form is preserved end-to-end.
  const fromObject = new RedisConnection({ url: REDIS_URL }, { skipWaitingForReady: true });
  await fromObject.initializing;
  assert.equal(
    fromObject.opts.url,
    REDIS_URL,
    'the url key is the only path init() uses to reach the right host',
  );
  // Note: opts still carries the constructor default host: '127.0.0.1' (the
  // Object.assign defaults always merge), but init() builds the client as
  // `new IORedisCtor(url, rest)` and ioredis parseOptions applies the URL
  // argument BEFORE the rest object (lodash.defaults only fills undefined
  // keys), so the URL's host wins. Verified live: effective host = URL host.
  assert.equal(captured.url, REDIS_URL);
});
