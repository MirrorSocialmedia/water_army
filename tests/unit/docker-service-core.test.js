/**
 * DockerService core — hermetic unit coverage (no network, no daemon):
 *  - log demux (framed + plain)
 *  - stats summarization math
 *  - env masking (sensitive keys masked server-side)
 *  - managed rules (label + admin exception)
 *  - §9.3 op protocol on the fake client: idempotent start/stop,
 *    re-inspect confirmation, OPERATION_PENDING on frozen state,
 *    404 / daemon-down / permission / timeout classification through
 *    the real service path, dead-container guards, delete confirm flow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDockerService,
  classifyDockerError,
  demuxDockerLogs,
  maskContainerEnv,
  isManaged,
  summarizeStats,
  DockerServiceError,
} from '../../apps/api/src/services/docker-service.js';
import { makeFakeDockerClient, makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';
import { makeFakeDb, testConfig } from '../helpers/fakes.js';
import { DOCKER_ERROR } from '@water-army/shared';

const SILENT_LOG = { info() {}, warn() {}, error() {} };
const NO_AUDIT = async () => {};

function makeService(clientOpts = {}) {
  const db = makeFakeDb({});
  const svc = createDockerService({
    docker: makeFakeDockerWrapper(clientOpts),
    db,
    config: testConfig,
    log: SILENT_LOG,
    audit: NO_AUDIT,
  });
  return { svc, db };
}

// ---------------------------------------------------------------- demux

test('demuxDockerLogs: multiplexed frames (stdout/stderr) and plain text', async (t) => {
  function frame(streamId, text) {
    const payload = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = streamId;
    head.writeUInt32BE(payload.length, 4);
    return Buffer.concat([head, payload]);
  }

  await t.test('framed: interleaved stdout/stderr kept in order, newlines split', () => {
    const buf = Buffer.concat([frame(1, 'line1\nline2\n'), frame(2, 'err1\n'), frame(1, 'line3\n')]);
    const { lines } = demuxDockerLogs(buf);
    assert.deepEqual(lines, ['line1', 'line2', 'err1', 'line3']);
  });

  await t.test('plain text fallback (no 8-byte header shape)', () => {
    const { lines } = demuxDockerLogs(Buffer.from('a\nb\n'));
    assert.deepEqual(lines, ['a', 'b']);
  });

  await t.test('empty buffer → empty', () => {
    assert.deepEqual(demuxDockerLogs(Buffer.alloc(0)).lines, []);
  });

  await t.test('torn first frame after head-truncation → stop cleanly, no crash', () => {
    const full = Buffer.concat([frame(1, 'hello\n'), frame(1, 'world\n')]);
    const torn = full.subarray(3); // cuts into the first header
    const { lines } = demuxDockerLogs(torn);
    assert.ok(Array.isArray(lines));
  });
});

// ---------------------------------------------------------------- stats

test('summarizeStats: cpu/mem math on a single sample', async (t) => {
  await t.test('normal sample → sane percents', () => {
    const s = summarizeStats({
      cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 100_000_000_000, online_cpus: 8 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 99_000_000_000 },
      memory_stats: { usage: 256 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
    });
    // cpuDelta=1e9, sysDelta=1e9 → ratio 1.0 × 8 cpus = 800%
    assert.equal(s.cpuPercent, 800);
    assert.equal(s.memPercent, 25);
    assert.equal(s.memUsageBytes, 256 * 1024 * 1024);
  });

  await t.test('zero sysDelta / missing pre → null cpu, no NaN, no crash', () => {
    const s = summarizeStats({
      cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      memory_stats: { usage: 0, limit: 0 },
    });
    assert.equal(s.cpuPercent, null);
    assert.equal(s.memPercent, null);
  });

  await t.test('null sample → nulls, no throw', () => {
    const s = summarizeStats(null);
    assert.equal(s.cpuPercent, null);
    assert.equal(s.memUsageBytes, 0);
  });
});

// ---------------------------------------------------------------- env masking

test('maskContainerEnv: sensitive keys masked, plain keys pass through', async (t) => {
  await t.test('docker array form', () => {
    const out = maskContainerEnv(['PATH=/usr/bin', 'DB_PASSWORD=hunter2', 'API_KEY=sk-live-abc', 'MODE=fast']);
    const byKey = Object.fromEntries(out.map((e) => [e.key, e]));
    assert.equal(byKey.MODE.value, 'fast');
    assert.equal(byKey.MODE.sensitive, false);
    assert.equal(byKey.DB_PASSWORD.sensitive, true);
    assert.ok(!byKey.DB_PASSWORD.value.includes('hunter2'), 'secret value must not survive masking');
    assert.ok(byKey.DB_PASSWORD.value.includes('7 chars'));
    assert.equal(byKey.API_KEY.sensitive, true);
  });

  await t.test('object form + empty value', () => {
    const out = maskContainerEnv({ GITHUB_TOKEN: '', PLAIN: 'x' });
    const gt = out.find((e) => e.key === 'GITHUB_TOKEN');
    assert.equal(gt.sensitive, true);
    assert.equal(gt.value, '••• (0 chars)');
    assert.equal(out.find((e) => e.key === 'PLAIN').value, 'x');
  });

  await t.test('keys containing sensitive segments are conservatively masked', () => {
    const out = maskContainerEnv(['PASSWORD_RESET_LINK_TEMPLATE=abc', 'TOKENIZER=fast']);
    assert.equal(out[0].sensitive, true); // PASSWORD segment
    assert.equal(out[1].sensitive, false); // TOKENIZER has no _ segment match
  });
});

// ---------------------------------------------------------------- managed rules

test('isManaged: label + exception semantics', async (t) => {
  await t.test('app.managed=true label → managed', () => {
    const r = isManaged({ labels: { 'app.managed': 'true' }, containerId: 'abc', exceptions: {} });
    assert.deepEqual(r, { managed: true, byException: false });
  });

  await t.test('label present but "false" → not managed', () => {
    const r = isManaged({ labels: { 'app.managed': 'false' }, containerId: 'abc', exceptions: {} });
    assert.equal(r.managed, false);
  });

  await t.test('no label + no exception → not managed', () => {
    const r = isManaged({ labels: {}, containerId: 'abc', name: 'other', exceptions: {} });
    assert.equal(r.managed, false);
    assert.equal(r.byException, false);
  });

  await t.test('admin exception by id or by name → managed-by-exception', () => {
    const exceptions = { abc123: { grantedBy: 'u1' }, 'legacy-app': { grantedBy: 'u1' } };
    assert.equal(isManaged({ labels: {}, containerId: 'abc123', name: 'x', exceptions }).managed, true);
    assert.equal(isManaged({ labels: {}, containerId: 'other', name: 'legacy-app', exceptions }).managed, true);
    assert.equal(isManaged({ labels: {}, containerId: 'other', name: 'y', exceptions }).managed, false);
  });

  await t.test('missing labels entirely → not managed (no crash)', () => {
    const r = isManaged({});
    assert.equal(r.managed, false);
  });
});

// ---------------------------------------------------------------- op protocol (§9.3)

test('op protocol on fake client: idempotency + re-inspect confirmation', async (t) => {
  await t.test('start already-running → idempotent success, NO daemon start call', async () => {
    const client = makeFakeDockerClient({
      containers: [{ id: 'a'.repeat(64), name: 'web', state: 'running', labels: { 'app.managed': 'true' } }],
    });
    const svc = createDockerService({ docker: { disabled: false, client, ping: async () => 'P' }, db: makeFakeDb({}), config: testConfig, log: SILENT_LOG, audit: NO_AUDIT });
    const res = await svc.runAction('web', 'start');
    assert.equal(res.idempotent, true);
    assert.equal(res.state, 'running');
    assert.ok(!client.__calls.some((c) => c.method === 'start'), 'must NOT call engine start when already running');
  });

  await t.test('start stopped → daemon start called, confirmed running', async () => {
    const client = makeFakeDockerClient({
      containers: [{ id: 'b'.repeat(64), name: 'app', state: 'exited', labels: { 'app.managed': 'true' } }],
    });
    const svc = createDockerService({ docker: { disabled: false, client, ping: async () => 'P' }, db: makeFakeDb({}), config: testConfig, log: SILENT_LOG, audit: NO_AUDIT });
    const res = await svc.runAction('app', 'start');
    assert.equal(res.idempotent, false);
    assert.equal(res.state, 'running');
    assert.ok(client.__calls.some((c) => c.method === 'start'), 'engine start must be called');
  });

  await t.test('stop already-exited → idempotent success (not a failure)', async () => {
    const { svc } = makeService({ containers: [{ id: 'c'.repeat(64), name: 'gone', state: 'exited' }] });
    const res = await svc.runAction('gone', 'stop');
    assert.equal(res.idempotent, true);
    assert.equal(res.state, 'exited');
  });

  await t.test('pause only while running (else 409), unpause only while paused', async () => {
    const { svc } = makeService({ containers: [{ id: 'd'.repeat(64), name: 'exited-one', state: 'exited' }] });
    await assert.rejects(
      () => svc.runAction('exited-one', 'pause'),
      (err) => err instanceof DockerServiceError && err.statusCode === 409,
    );
  });

  await t.test('pause already-paused → idempotent success (target state, MD §9.3)', async () => {
    const { svc } = makeService({ containers: [{ id: 'd'.repeat(64), name: 'paused-one', state: 'paused' }] });
    const res = await svc.runAction('paused-one', 'pause');
    assert.equal(res.idempotent, true);
    assert.equal(res.state, 'paused');
  });

  await t.test('unpause paused → running; unpause already-running → idempotent', async () => {
    const { svc } = makeService({ containers: [{ id: 'd'.repeat(64), name: 'paused-two', state: 'paused' }] });
    const res = await svc.runAction('paused-two', 'unpause');
    assert.equal(res.state, 'running');
    assert.equal(res.idempotent, false);
    const again = await svc.runAction('paused-two', 'unpause');
    assert.equal(again.idempotent, true);
  });

  await t.test('dead container: start/restart rejected with 409 guidance, not a fake success', async () => {
    const { svc } = makeService({ containers: [{ id: 'e'.repeat(64), name: 'dead-one', state: 'dead' }] });
    await assert.rejects(
      () => svc.runAction('dead-one', 'start'),
      (err) => err instanceof DockerServiceError && err.statusCode === 409,
    );
    await assert.rejects(
      () => svc.runAction('dead-one', 'restart'),
      (err) => err instanceof DockerServiceError && err.statusCode === 409,
    );
  });

  await t.test('restart performs even when running; restartCount advanced', async () => {
    const client = makeFakeDockerClient({ containers: [{ id: 'f'.repeat(64), name: 'rt', state: 'running' }] });
    const svc = createDockerService({ docker: { disabled: false, client, ping: async () => 'P' }, db: makeFakeDb({}), config: testConfig, log: SILENT_LOG, audit: NO_AUDIT });
    const res = await svc.runAction('rt', 'restart');
    assert.equal(res.state, 'running');
    assert.equal(res.idempotent, false);
    assert.equal(client.__byId.get('f'.repeat(64)).restarts, 1);
  });
});

test('op protocol: OPERATION_PENDING when API succeeds but state unchanged (MD §9.3)', async (t) => {
  await t.test('start frozen → OPERATION_PENDING (never a fake success)', async () => {
    const client = makeFakeDockerClient({ containers: [{ id: '1'.repeat(64), name: 'flaky', state: 'exited' }] });
    client.__freeze('flaky');
    const svc = createDockerService({ docker: { disabled: false, client, ping: async () => 'P' }, db: makeFakeDb({}), config: testConfig, log: SILENT_LOG, audit: NO_AUDIT });
    await assert.rejects(
      () => svc.runAction('flaky', 'start'),
      (err) => err instanceof DockerServiceError && err.apiCode === DOCKER_ERROR.OPERATION_PENDING && /flaky/.test(err.message),
    );
  });

  await t.test('delete frozen → OPERATION_PENDING (still inspects)', async () => {
    const client = makeFakeDockerClient({ containers: [{ id: '2'.repeat(64), name: 'stubborn', state: 'exited' }] });
    client.__freeze('stubborn');
    const svc = createDockerService({ docker: { disabled: false, client, ping: async () => 'P' }, db: makeFakeDb({}), config: testConfig, log: SILENT_LOG, audit: NO_AUDIT });
    await assert.rejects(
      () => svc.deleteContainer('stubborn', { confirm: 'stubborn' }),
      (err) => err.apiCode === DOCKER_ERROR.OPERATION_PENDING,
    );
  });
});

test('delete: two-step confirmation + success path', async (t) => {
  await t.test('wrong/missing confirm → 400 VALIDATION_ERROR, container untouched', async () => {
    const { svc } = makeService({ containers: [{ id: '3'.repeat(64), name: 'victim', state: 'exited' }] });
    await assert.rejects(
      () => svc.deleteContainer('victim', { confirm: 'WRONG' }),
      (err) => err.apiCode === 'VALIDATION_ERROR' && err.statusCode === 400,
    );
    await assert.rejects(() => svc.deleteContainer('victim', {}), (err) => err.apiCode === 'VALIDATION_ERROR');
  });

  await t.test('correct confirm (name or id) → deleted; bind info reported', async () => {
    const { svc } = makeService({
      containers: [
        {
          id: '4'.repeat(64),
          name: 'bindy',
          state: 'exited',
          mounts: [{ Type: 'bind', Source: '/data/x', Destination: '/data', RW: true }],
        },
      ],
    });
    const res = await svc.deleteContainer('4'.repeat(64), { confirm: 'bindy' });
    assert.equal(res.deleted, true);
    assert.equal(res.bindsPreserved, true); // default: binds survive
  });
});

test('error paths through the service (classified, never generic 500)', async (t) => {
  async function expectCode(opts, fn, code, status) {
    const { svc } = makeService(opts);
    await assert.rejects(
      () => fn(svc),
      (err) => {
        assert.ok(err instanceof DockerServiceError, `expected DockerServiceError, got ${err?.name}: ${err?.message}`);
        assert.equal(err.apiCode, code, `expected ${code}, got ${err.apiCode} (${err.message})`);
        assert.equal(err.statusCode, status);
        return true;
      },
    );
  }

  await t.test('inspect unknown container → CONTAINER_NOT_FOUND 404', async () => {
    await expectCode({}, (svc) => svc.inspectSummary('ghost123'), DOCKER_ERROR.CONTAINER_NOT_FOUND, 404);
  });

  await t.test('logs unknown container → CONTAINER_NOT_FOUND 404', async () => {
    await expectCode({}, (svc) => svc.getLogs('ghost123'), DOCKER_ERROR.CONTAINER_NOT_FOUND, 404);
  });

  await t.test('daemon down (ECONNREFUSED) → DAEMON_UNAVAILABLE 503, NOT not-found', async () => {
    await expectCode({ mode: 'daemon-down' }, (svc) => svc.listContainers(), DOCKER_ERROR.DAEMON_UNAVAILABLE, 503);
    await expectCode({ mode: 'daemon-down' }, (svc) => svc.inspectSummary('anything'), DOCKER_ERROR.DAEMON_UNAVAILABLE, 503);
  });

  await t.test('permission denied (EACCES) → PERMISSION_DENIED 502', async () => {
    await expectCode({ mode: 'permission-denied' }, (svc) => svc.listContainers(), DOCKER_ERROR.PERMISSION_DENIED, 502);
  });

  await t.test('timeout → TIMEOUT 504', async () => {
    await expectCode({ mode: 'timeout' }, (svc) => svc.listContainers(), DOCKER_ERROR.TIMEOUT, 504);
  });

  await t.test('disabled config → DOCKER_DISABLED 503 with clear message', async () => {
    const svc = createDockerService({
      docker: { disabled: true, client: null, ping: async () => { throw new Error('disabled'); } },
      db: makeFakeDb({}),
      config: testConfig,
      log: SILENT_LOG,
      audit: NO_AUDIT,
    });
    await assert.rejects(
      () => svc.listContainers(),
      (err) => err.apiCode === DOCKER_ERROR.DISABLED && err.statusCode === 503 && /disabled/i.test(err.message),
    );
  });
});

test('list: filters, pagination, q, withStats partial errors (MD §9.4)', async (t) => {
  const seed = [
    { id: 'a'.repeat(64), name: 'alpha', state: 'running', image: 'web:1', labels: { 'app.managed': 'true', 'app.template': 't1' } },
    { id: 'b'.repeat(64), name: 'beta', state: 'exited', image: 'api:1', labels: {} },
    { id: 'c'.repeat(64), name: 'gamma-cache', state: 'paused', image: 'cache:2', labels: { 'app.managed': 'true' } },
  ];

  await t.test('no filters → all, sorted by name', async () => {
    const { svc } = makeService({ containers: seed });
    const res = await svc.listContainers({});
    assert.equal(res.total, 3);
    assert.deepEqual(res.items.map((i) => i.name), ['alpha', 'beta', 'gamma-cache']);
  });

  await t.test('state filter (single + comma list)', async () => {
    const { svc } = makeService({ containers: seed });
    assert.equal((await svc.listContainers({ state: 'running' })).total, 1);
    assert.equal((await svc.listContainers({ state: 'running,paused' })).total, 2);
  });

  await t.test('managed filter true/false', async () => {
    const { svc } = makeService({ containers: seed });
    assert.equal((await svc.listContainers({ managed: 'true' })).total, 2);
    assert.equal((await svc.listContainers({ managed: 'false' })).total, 1);
  });

  await t.test('q matches name / image / id substring (case-insensitive)', async () => {
    const { svc } = makeService({ containers: seed });
    assert.equal((await svc.listContainers({ q: 'GAMMA' })).total, 1);
    assert.equal((await svc.listContainers({ q: 'api:1' })).total, 1);
    assert.equal((await svc.listContainers({ q: 'c'.repeat(6) })).total, 1);
  });

  await t.test('pagination slices + reports total', async () => {
    const { svc } = makeService({ containers: seed });
    const page2 = await svc.listContainers({ page: 2, pageSize: 2 });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.total, 3);
  });

  await t.test('withStats: running gets numbers, non-running gets per-item partial error', async () => {
    const { svc } = makeService({ containers: seed });
    const res = await svc.listContainers({ withStats: true });
    const alpha = res.items.find((i) => i.name === 'alpha');
    const beta = res.items.find((i) => i.name === 'beta');
    const gamma = res.items.find((i) => i.name === 'gamma-cache');
    assert.equal(typeof alpha.stats.cpuPercent, 'number');
    assert.equal(alpha.stats.memPercent, 25);
    // fake: stats on non-running → engine 500 → classified per-item error
    assert.equal(beta.stats.error, DOCKER_ERROR.GENERIC);
    assert.equal(gamma.stats.error, DOCKER_ERROR.GENERIC);
  });
});

test('logs: tail bounding, byte cap truncation, since validation', async (t) => {
  const logText = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n') + '\n';
  const big = Array.from({ length: 1200 }, (_, i) => `L${i}`).join('\n') + '\n';

  await t.test('default tail 500 → last 500 lines only', async () => {
    const { svc } = makeService({ containers: [{ id: 'l'.repeat(64), name: 'chatty', state: 'running', logs: big }] });
    const res = await svc.getLogs('chatty');
    assert.equal(res.lines.length, 500);
    assert.equal(res.lines.at(-1), 'L1199');
    assert.equal(res.truncated, false); // tail cap is by design, not truncation
  });

  await t.test('byte cap → keeps the TAIL (newest) and marks truncated', async () => {
    const svc2 = createDockerService({
      docker: makeFakeDockerWrapper({ containers: [{ id: 'l'.repeat(64), name: 'chatty', state: 'running', logs: big }] }),
      db: makeFakeDb({}),
      config: { ...testConfig, dockerLogByteLimit: 64 },
      log: SILENT_LOG,
      audit: NO_AUDIT,
    });
    const res = await svc2.getLogs('chatty', { tail: 1200 });
    assert.equal(res.truncated, true);
    assert.equal(res.byteLength, 64);
    assert.match(res.lines.at(-1), /^L\d+$/);
  });

  await t.test('tail above cap is clamped to cap (no unbounded reads)', async () => {
    const bigger = Array.from({ length: 7000 }, (_, i) => `L${i}`).join('\n') + '\n';
    const { svc } = makeService({ containers: [{ id: 'l'.repeat(64), name: 'chatty', state: 'running', logs: bigger }] });
    const res = await svc.getLogs('chatty', { tail: 999999 });
    assert.equal(res.lines.length, 5000); // testConfig cap
  });

  await t.test('bad since → 400 VALIDATION_ERROR', async () => {
    const { svc } = makeService({ containers: [{ id: 'l'.repeat(64), name: 'chatty', state: 'running', logs: logText }] });
    await assert.rejects(() => svc.getLogs('chatty', { since: 'not-a-time' }), (err) => err.apiCode === 'VALIDATION_ERROR');
  });

  await t.test('bad tail → 400', async () => {
    const { svc } = makeService({ containers: [{ id: 'l'.repeat(64), name: 'chatty', state: 'running', logs: logText }] });
    await assert.rejects(() => svc.getLogs('chatty', { tail: 0 }), (err) => err.apiCode === 'VALIDATION_ERROR');
  });

  await t.test('since accepts unix seconds + ISO', async () => {
    const { svc } = makeService({ containers: [{ id: 'l'.repeat(64), name: 'chatty', state: 'running', logs: logText }] });
    const a = await svc.getLogs('chatty', { since: 1760000000 });
    const b = await svc.getLogs('chatty', { since: '2026-01-01T00:00:00Z' });
    assert.equal(a.lines.length, 100);
    assert.equal(b.lines.length, 100);
  });
});

test('classifyDockerError is exported and stable for P3 reuse', () => {
  assert.equal(typeof classifyDockerError, 'function');
});
