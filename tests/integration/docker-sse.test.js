/**
 * SSE event stream (施工 MD §9.4).
 *
 * NOTE 1: `app.inject()` can NEVER be used on the hijacked /events route —
 * light-my-request only settles its promise on response end, and a hijacked
 * SSE stream never "ends". These tests therefore run a REAL listener
 * (app.listen on an ephemeral port) with fetch + AbortController, exactly
 * like a browser client.
 *
 * NOTE 2: an undici fetch body reader must NEVER have a pending read() that
 * is "abandoned" by a Promise.race timeout — the stream stalls and no later
 * data is ever delivered (measured, probe-verified). So a single background
 * pump owns the reader; assertions just wait on its buffer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk } from '../helpers/fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';

async function makeApp({ config = testConfig, dockerOpts = {} } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeFakeDb({ users: [{ id: 'u1', username: 'admin', passwordHash, role: 'admin' }] });
  const docker = makeFakeDockerWrapper({ containers: [], ...dockerOpts });
  const app = await buildApp({ config, db, redis: fakeRedisOk(), docker });
  return { app, db, docker };
}

async function startServer(app) {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  return `http://127.0.0.1:${port}`;
}

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(res.status, 200, await res.text());
  return res.headers.get('set-cookie').split(';')[0]; // session=<jwt>
}

/**
 * Single-owner buffer for a live SSE body. The background pump is the ONLY
 * caller of reader.read() — no abandoned reads, ever.
 */
function startBuffer(reader) {
  const dec = new TextDecoder();
  let text = '';
  let streamEnded = false;
  const wakeups = new Set();
  const wake = () => {
    for (const w of [...wakeups]) w();
    wakeups.clear();
  };
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { streamEnded = true; wake(); break; }
        if (value) { text += dec.decode(value, { stream: true }); wake(); }
      }
    } catch {
      streamEnded = true;
      wake(); // aborted — unblock waiters
    }
  })();

  async function until(pred, { ms = 5000 } = {}) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (pred(text)) return text;
      if (streamEnded) throw new Error(`until: stream ended before condition; buffer: ${JSON.stringify(text.slice(0, 200))}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`until: timeout before condition; buffer: ${JSON.stringify(text.slice(0, 200))}`);
      await new Promise((resolve) => {
        const w = () => { wakeups.delete(w); resolve(); };
        wakeups.add(w);
        setTimeout(w, remaining); // safety net — resolves even if no data arrives
      });
    }
  }

  return { until, text: () => text };
}

function frames(text) {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const data = b.split('\n').find((l) => l.startsWith('data: '));
      return { event: b.split('\n')[0].slice('event:'.length).trim(), data: data ? JSON.parse(data.slice('data: '.length)) : null };
    });
}

async function openSse(base, cookie) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/containers/events`, { headers: { cookie, accept: 'text/event-stream' }, signal: ctrl.signal });
  if (res.status !== 200) {
    // Error responses are finite — safe to read. (NEVER .text() a live SSE stream.)
    const body = await res.text();
    throw new Error(`expected 200, got ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = startBuffer(res.body.getReader());
  await buf.until((x) => x.includes('retry: 3000'));
  return { res, ctrl, buf };
}

test('SSE over real HTTP: headers, preamble, forwarding, filtering, robustness, disconnect', async (t) => {
  const { app, docker } = await makeApp();
  const base = await startServer(app);
  const cookie = await login(base);
  let sse = null;

  t.after(async () => {
    try { sse?.ctrl.abort(); } catch { /* already closed */ }
    await app.close();
  });

  await t.test('connect: 200 + text/event-stream + no-cache + x-accel-buffering + retry preamble', async () => {
    sse = await openSse(base, cookie);
    assert.match(sse.res.headers.get('content-type'), /text\/event-stream/);
    assert.match(sse.res.headers.get('cache-control'), /no-cache/);
    assert.equal(sse.res.headers.get('x-accel-buffering'), 'no');
    assert.match(sse.buf.text(), /^retry: 3000\n\n/);
  });

  await t.test('container start event → forwarded as `event: container` with §9.4 payload', async () => {
    docker.client.__pushEvent({ Action: 'start', Actor: { ID: 'a'.repeat(64), Attributes: { name: 'app', image: 'app:1' } }, timestamp: '2026-10-14T12:00:00Z' });
    const text = await sse.buf.until((x) => x.includes('"action":"start"'));
    const [f] = frames(text);
    assert.equal(f.event, 'container');
    assert.equal(f.data.action, 'start');
    assert.equal(f.data.id, 'a'.repeat(64));
    assert.equal(f.data.name, 'app');
    assert.equal(f.data.image, 'app:1');
    assert.equal(f.data.timestamp, '2026-10-14T12:00:00Z');
  });

  await t.test('non-container type (image) + non-whitelisted action (exec_create) → NOT forwarded', async () => {
    const before = frames(sse.buf.text()).length;
    docker.client.__pushEvent({ Type: 'image', Action: 'create', Actor: { ID: 'sha256:zz', Attributes: {} } });
    docker.client.__pushEvent({ Action: 'exec_create', Actor: { ID: 'a'.repeat(64), Attributes: { name: 'app' } } });
    await new Promise((r) => setTimeout(r, 300)); // give any (wrong) forwarding time to arrive
    assert.equal(frames(sse.buf.text()).length, before, 'image + exec_create events must not reach the UI');
  });

  await t.test('malformed frame lines → skipped, stream stays alive for later events', async () => {
    const before = frames(sse.buf.text()).length;
    docker.client.__pushRawLine('{torn json — oops');
    docker.client.__pushRawLine('not json at all');
    await new Promise((r) => setTimeout(r, 200));

    // stream must still be usable afterwards
    docker.client.__pushEvent({ Action: 'die', Actor: { ID: 'b'.repeat(64), Attributes: { name: 'app2', image: 'app2:1' } }, timestamp: '2026-10-14T12:01:00Z' });
    const text = await sse.buf.until((x) => frames(x).length > before);
    assert.equal(frames(text).at(-1).data.action, 'die');
  });

  await t.test('abort → server releases the docker event stream (active back to 0)', async () => {
    assert.equal(app.dockerService.sseStats().active, 1);
    sse.ctrl.abort();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(app.dockerService.sseStats().active, 0, 'client disconnect must release the stream (MD §9.4)');
    sse = null;
  });
});

test('SSE: concurrency cap → 503 SSE_LIMIT (not hijacked)', async (t) => {
  const { app } = await makeApp({ config: { ...testConfig, dockerSseMaxConcurrent: 2 } });
  const base = await startServer(app);
  const cookie = await login(base);
  const streams = [];

  t.after(async () => {
    for (const s of streams) { try { s.ctrl.abort(); } catch { /* closed */ } }
    await app.close();
  });

  await t.test('third stream at cap → 503 + envelope (plain JSON response)', async () => {
    for (let i = 0; i < 2; i++) {
      streams.push(await openSse(base, cookie));
    }
    const res = await fetch(`${base}/api/containers/events`, { headers: { cookie, accept: 'text/event-stream' } });
    const bodyText = await res.text(); // read ONCE (undici bodies are single-consumption)
    assert.equal(res.status, 503, bodyText);
    const body = JSON.parse(bodyText);
    assert.equal(body.error.code, 'SSE_LIMIT');
    assert.match(body.error.message, /max 2/);
    assert.equal(app.dockerService.sseStats().active, 2);
  });

  await t.test('abandoning one stream frees the slot', async () => {
    streams[0].ctrl.abort();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(app.dockerService.sseStats().active, 1);
    streams.push(await openSse(base, cookie));
    assert.equal(app.dockerService.sseStats().active, 2);
  });
});

test('SSE service: release() is idempotent + destroys the docker stream', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());
  const svc = app.dockerService;

  await t.test('active count tracks open/release; double release is a no-op', async () => {
    assert.equal(svc.sseStats().active, 0);
    const a = await svc.openEventStream({});
    const b = await svc.openEventStream({});
    assert.equal(svc.sseStats().active, 2);
    a.release();
    a.release(); // idempotent — must not double-decrement
    assert.equal(svc.sseStats().active, 1);
    assert.equal(a.stream.destroyed, true, 'release must destroy the docker event stream');
    b.release();
    assert.equal(svc.sseStats().active, 0);
  });

  await t.test('over-cap open → SSE_LIMIT (service level)', async () => {
    const a = await svc.openEventStream({ maxConcurrent: 1 });
    await assert.rejects(
      () => svc.openEventStream({ maxConcurrent: 1 }),
      (err) => err.apiCode === 'SSE_LIMIT' && err.statusCode === 503,
    );
    a.release();
  });
});

test('SSE: daemon down → 503 DOCKER_DAEMON_UNAVAILABLE (plain response, no hijack)', async (t) => {
  const { app } = await makeApp({ dockerOpts: { mode: 'daemon-down' } });
  const base = await startServer(app);
  const cookie = await login(base);
  t.after(() => app.close());
  const res = await fetch(`${base}/api/containers/events`, { headers: { cookie, accept: 'text/event-stream' } });
  const bodyText = await res.text(); // read ONCE
  assert.equal(res.status, 503, bodyText);
  const body = JSON.parse(bodyText);
  assert.equal(body.error.code, 'DOCKER_DAEMON_UNAVAILABLE');
});
