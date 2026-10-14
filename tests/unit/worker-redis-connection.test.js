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
