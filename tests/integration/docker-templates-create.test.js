/**
 * Templates + create-from-template + managed exceptions (施工 MD §9.2 / §11.2 / §13):
 *  - template upsert (admin only) + validation: pinned images, no latest,
 *    no host/none network, privileged requires reason, bind paths allowlisted,
 *    host PID unrepresentable
 *  - create: allowlist-only config, labels, idempotency (replay + name-collision
 *    backstop), port ranges, env allowlist, command-override gate, 409s,
 *    audit carries env KEYS only (never values)
 *  - exceptions: grant/revoke flip the managed gate; admin-only
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk } from '../helpers/fakes.js';
import { makeFakeDockerWrapper } from '../helpers/fake-docker-client.js';

const { argon2id, hash } = argon2;
const PASSWORD = 'TestPass123';
const WEB_ID = 'web'.repeat(1); // 'web'
const LEGACY_ID = 'c'.repeat(64);

const WEB_TEMPLATE = {
  id: 'web',
  displayName: 'Web',
  image: 'nginx:1.27',
  cpuLimit: 1,
  memoryLimitBytes: 256 * 1024 * 1024,
  ports: [{ containerPort: 80, protocol: 'tcp', hostPortMin: 8000, hostPortMax: 8099 }],
  allowedEnvKeys: ['LOG_LEVEL', 'APP_ENV'],
};

async function makeApp({ containers = [] } = {}) {
  const passwordHash = await hash(PASSWORD, { type: argon2id });
  const db = makeFakeDb({
    users: [
      { id: 'u-admin', username: 'admin', passwordHash, role: 'admin' },
      { id: 'u-operator', username: 'operator', passwordHash, role: 'operator' },
      { id: 'u-viewer', username: 'viewer', passwordHash, role: 'viewer' },
    ],
  });
  const app = await buildApp({
    config: testConfig,
    db,
    redis: fakeRedisOk(),
    docker: makeFakeDockerWrapper({ containers }),
  });
  return { app, db };
}

async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `login ${username}: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

test('template upsert: admin lifecycle + validation', async (t) => {
  const { app, db } = await makeApp();
  t.after(() => app.close());
  const admin = await login(app, 'admin');
  const viewer = await login(app, 'viewer');
  const H = { cookie: admin };

  await t.test('valid template → 201 created + audit template.create', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates', headers: H, payload: WEB_TEMPLATE });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().created, true);
    assert.equal(res.json().template.image, 'nginx:1.27');
    const audit = db.__state.auditRows.find((a) => a.action === 'template.create');
    assert.ok(audit, 'template.create must be audited');
    assert.equal(audit.resourceId, 'web');
  });

  await t.test('re-post same id → 200 created:false (idempotent upsert, not a duplicate)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates', headers: H, payload: WEB_TEMPLATE });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().created, false);
    const list = await app.inject({ method: 'GET', url: '/api/templates', headers: H });
    assert.equal(list.json().templates.length, 1, 'no duplicate template rows');
  });

  await t.test('GET list → 200 for viewer (read); POST → 403 for operator and viewer', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie: viewer } });
    assert.equal(list.statusCode, 200);
    const operator = await login(app, 'operator');
    assert.equal((await app.inject({ method: 'POST', url: '/api/templates', headers: { cookie: operator }, payload: WEB_TEMPLATE })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/templates', headers: { cookie: viewer }, payload: WEB_TEMPLATE })).statusCode, 403);
  });

  await t.test('validation rejections (each → 400 VALIDATION_ERROR)', async () => {
    const bad = async (patch, label) => {
      const res = await app.inject({ method: 'POST', url: '/api/templates', headers: H, payload: { ...WEB_TEMPLATE, id: `bad-${label}`, ...patch } });
      assert.equal(res.statusCode, 400, `${label}: ${res.body}`);
      assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    };
    await bad({ image: 'nginx' }, 'untagged-image');
    await bad({ image: 'nginx:latest' }, 'latest-tag');
    await bad({ network: 'host' }, 'host-network');
    await bad({ network: 'none' }, 'none-network');
    await bad({ privileged: true }, 'privileged-without-reason');
    await bad({ privileged: true, privilegedReason: 'short' }, 'privileged-short-reason');
    await bad({ pidMode: 'host' }, 'pidmode');
    await bad({ volumes: [{ containerPath: '/data', type: 'bind', hostPath: '/' }], allowedHostPaths: ['/data'] }, 'bind-root');
    await bad({ volumes: [{ containerPath: '/data', type: 'bind', hostPath: '/var/run/docker.sock' }] }, 'bind-docker-sock');
    await bad({ volumes: [{ containerPath: '/data', type: 'bind', hostPath: '/srv/app' }], allowedHostPaths: ['/data'] }, 'bind-not-allowlisted');
    await bad({ ports: [{ containerPort: 80 }, { containerPort: 80 }] }, 'duplicate-port');
  });

  await t.test('privileged WITH reason (redroid class) → accepted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: H,
      payload: { ...WEB_TEMPLATE, id: 'emu', displayName: 'Emulator', image: 'redroid/redroid:15.0.0-latest', privileged: true, privilegedReason: 'android emulator requires privileged GPU/virtio access for redroid-class runtime' },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().template.privileged, true);
  });

  await t.test('custom network must exist on the daemon → 400 when missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates', headers: H, payload: { ...WEB_TEMPLATE, id: 'net-x', network: 'does-not-exist' } });
    assert.equal(res.statusCode, 400, res.body);
  });
});

test('create from template: allowlist-only, labels, idempotency, 409s', async (t) => {
  const { app, db } = await makeApp({ containers: [] });
  t.after(() => app.close());
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const H = { cookie: operator };

  // Seed the template via the admin route (not a shortcut).
  let res = await app.inject({ method: 'POST', url: '/api/templates', headers: { cookie: admin }, payload: WEB_TEMPLATE });
  assert.equal(res.statusCode, 201, res.body);

  await t.test('valid create → 201, running, labels set, audited with env KEYS only', async () => {
    res = await app.inject({
      method: 'POST',
      url: '/api/containers',
      headers: H,
      payload: { templateId: 'web', name: 'web-1', idempotencyKey: 'create-web-1-a', ports: [{ containerPort: 80, hostPort: 8080 }], env: { LOG_LEVEL: 'debug', APP_ENV: 'test' } },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().container.state, 'running');
    assert.equal(res.headers['idempotent-replay'], undefined);

    const list = await app.inject({ method: 'GET', url: '/api/containers?q=web-1', headers: H });
    assert.equal(list.json().total, 1);
    const row = list.json().items[0];
    assert.equal(row.managed, true);
    assert.equal(row.template, 'web');

    const inspect = await app.inject({ method: 'GET', url: '/api/containers/web-1', headers: H });
    const labels = inspect.json().labels;
    assert.equal(labels['app.managed'], 'true');
    assert.equal(labels['app.template'], 'web');
    assert.equal(labels['app.created-by'], 'u-operator');
    assert.equal(labels['app.idempotency-key'], 'create-web-1-a');

    const audit = db.__state.auditRows.find((a) => a.action === 'container.create' && a.status === 'success');
    assert.ok(audit);
    assert.deepEqual(audit.detailsJson.envKeys.sort(), ['APP_ENV', 'LOG_LEVEL']);
    assert.ok(!JSON.stringify(audit).includes('debug'), 'env VALUE must never reach the audit trail');
    assert.ok(!JSON.stringify(audit).includes('test'), 'env VALUE must never reach the audit trail (2)');
  });

  await t.test('idempotent replay: same key → header idempotent-replay, NO second container', async () => {
    res = await app.inject({
      method: 'POST',
      url: '/api/containers',
      headers: H,
      payload: { templateId: 'web', name: 'web-1', idempotencyKey: 'create-web-1-a', ports: [{ containerPort: 80, hostPort: 8080 }], env: { LOG_LEVEL: 'debug', APP_ENV: 'test' } },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.headers['idempotent-replay'], 'true');
    const list = await app.inject({ method: 'GET', url: '/api/containers', headers: H });
    assert.equal(list.json().total, 1, 'replay must not create a second container');
  });

  await t.test('env key outside allowlist → 400', async () => {
    res = await app.inject({
      method: 'POST',
      url: '/api/containers',
      headers: H,
      payload: { templateId: 'web', name: 'web-2', idempotencyKey: 'create-web-2-a', env: { LOG_LEVEL: 'x', UNAUTHORIZED_KEY: 'y' } },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /UNAUTHORIZED_KEY/);
  });

  await t.test('port not in template / hostPort outside range → 400', async () => {
    res = await app.inject({ method: 'POST', url: '/api/containers', headers: H, payload: { templateId: 'web', name: 'web-3', idempotencyKey: 'create-web-3-a', ports: [{ containerPort: 443, hostPort: 8443 }] } });
    assert.equal(res.statusCode, 400, res.body);
    res = await app.inject({ method: 'POST', url: '/api/containers', headers: H, payload: { templateId: 'web', name: 'web-3', idempotencyKey: 'create-web-3-b', ports: [{ containerPort: 80, hostPort: 9999 }] } });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error.message, /outside template range/);
  });

  await t.test('command override on a template that forbids it → 400', async () => {
    res = await app.inject({ method: 'POST', url: '/api/containers', headers: H, payload: { templateId: 'web', name: 'web-4', idempotencyKey: 'create-web-4-a', command: ['sh', '-c', 'sleep 1'] } });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error.message, /command override/i);
  });

  await t.test('unknown templateId → 404 TEMPLATE_NOT_FOUND', async () => {
    res = await app.inject({ method: 'POST', url: '/api/containers', headers: H, payload: { templateId: 'ghost', name: 'web-5', idempotencyKey: 'create-web-5-a' } });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error.code, 'TEMPLATE_NOT_FOUND');
  });

  await t.test('name collision → 409 NAME_TAKEN (durable backstop, independent of idempotency key)', async () => {
    res = await app.inject({ method: 'POST', url: '/api/containers', headers: H, payload: { templateId: 'web', name: 'web-1', idempotencyKey: 'create-web-1-NEW' } });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'NAME_TAKEN');
  });

  await t.test('host port already published → 409 PORT_IN_USE', async () => {
    res = await app.inject({ method: 'POST', url: '/api/containers', headers: H, payload: { templateId: 'web', name: 'web-6', idempotencyKey: 'create-web-6-a', ports: [{ containerPort: 80, hostPort: 8080 }] } });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'PORT_IN_USE');
  });
});

test('managed exceptions: admin grant/revoke flips the gate', async (t) => {
  const { app, db } = await makeApp({ containers: [{ id: LEGACY_ID, name: 'legacy', state: 'running', image: 'legacy:9', labels: {} }] });
  t.after(() => app.close());
  const admin = await login(app, 'admin');
  const operator = await login(app, 'operator');
  const H = { cookie: admin };
  const HO = { cookie: operator };

  await t.test('unmanaged → operator stop 403 NOT_MANAGED', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/containers/legacy/stop', headers: HO });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error.code, 'NOT_MANAGED');
  });

  await t.test('non-admin grant attempts → 403', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/containers/exceptions', headers: HO, payload: { name: 'legacy' } })).statusCode, 403);
    const viewer = await login(app, 'viewer');
    assert.equal((await app.inject({ method: 'POST', url: '/api/containers/exceptions', headers: { cookie: viewer }, payload: { name: 'legacy' } })).statusCode, 403);
  });

  await t.test('admin grant by name → 201 + audit; operator can now stop (byException:true)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/containers/exceptions', headers: H, payload: { name: 'legacy', note: 'migration hold' } });
    assert.equal(res.statusCode, 201, res.body);
    const grantAudit = db.__state.auditRows.find((a) => a.action === 'docker.exception.grant');
    assert.ok(grantAudit);
    assert.equal(grantAudit.detailsJson.note, 'migration hold');

    const stop = await app.inject({ method: 'POST', url: '/api/containers/legacy/stop', headers: HO });
    assert.equal(stop.statusCode, 200, stop.body);
    assert.equal(stop.json().byException, true);
  });

  await t.test('exceptions list (admin) shows the entry; revoke → 204 + audit; gate closes again', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/containers/exceptions', headers: H });
    assert.equal(list.statusCode, 200, list.body);
    // Grant by name resolves to the daemon id as the stable key.
    const entry = list.json().exceptions.find((e) => e.name === 'legacy');
    assert.ok(entry, 'entry visible in list');
    assert.equal(entry.key, LEGACY_ID, 'name grant resolves to id key');

    const del = await app.inject({ method: 'DELETE', url: `/api/containers/exceptions/${entry.key}`, headers: H });
    assert.equal(del.statusCode, 204, del.body);
    assert.ok(db.__state.auditRows.some((a) => a.action === 'docker.exception.revoke'));

    const stop = await app.inject({ method: 'POST', url: '/api/containers/legacy/start', headers: HO });
    assert.equal(stop.statusCode, 403, stop.body);
    assert.equal(stop.json().error.code, 'NOT_MANAGED');
  });

  await t.test('grant by containerId resolves to id key; unknown exception key → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/containers/exceptions', headers: H, payload: { containerId: LEGACY_ID, note: 'by id' } });
    assert.equal(res.statusCode, 201, res.body);
    const del = await app.inject({ method: 'DELETE', url: `/api/containers/exceptions/${LEGACY_ID}`, headers: H });
    assert.equal(del.statusCode, 204);
    const ghost = await app.inject({ method: 'DELETE', url: '/api/containers/exceptions/nosuch', headers: H });
    assert.equal(ghost.statusCode, 404);
  });
});
