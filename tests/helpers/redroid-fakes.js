/**
 * P5 test helpers — redroid fakes (工單 scope 8: mock 驗證主路徑).
 *
 * The mock adapter itself lives in production code (src/services/redroid-mock.js)
 * so REDROID_ADAPTER=mock is a first-class provider switch (P3 provider
 * pattern). This file is the TEST wiring:
 *   - makeRedroidTestApp(): buildApp with mock redroid env + tmp data root
 *   - seedRedroidTemplates(): standard 2 templates (privileged-host + swiftshader)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import argon2 from '@node-rs/argon2';

import { buildApp } from '../../apps/api/src/app.js';
import { makeFakeDb, testConfig, fakeRedisOk } from './fakes.js';

const { argon2id, hash } = argon2;
export const TEST_PASSWORD = 'TestPass123';

/**
 * @param {object} [opts]
 * @param {object} [opts.dockerOpts] mock redroid docker opts (startFails etc.)
 * @param {object} [opts.adbOpts] mock adb opts (online etc.)
 * @param {object} [opts.configOverride]
 */
export async function makeRedroidTestApp({ redroidMockOpts = {}, configOverride = {} } = {}) {
  const passwordHash = await hash(TEST_PASSWORD, { type: argon2id });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-p5-redroid-'));
  const db = makeFakeDb({
    users: [
      { id: 'u-admin', username: 'admin', passwordHash, role: 'admin' },
      { id: 'u-operator', username: 'operator', passwordHash, role: 'operator' },
      { id: 'u-viewer', username: 'viewer', passwordHash, role: 'viewer' },
    ],
  });
  const config = {
    ...testConfig,
    redroidAdapter: 'mock',
    redroidDataRoot: dataRoot,
    redroidAdbRangeStart: 15000,
    redroidAdbRangeEnd: 15999,
    ...configOverride,
  };
  const app = await buildApp({
    config,
    db,
    redis: fakeRedisOk(),
    // P2 container routes stay inert (disabled wrapper); the redroid service
    // uses the deterministic mock env (REDROID_ADAPTER=mock, test seam).
    docker: makeContainerFake(),
    redroidMockOpts,
  });
  return { app, db, dataRoot, redroidMock: app.redroidMockEnv, close: async () => { await app.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); } };
}

function makeContainerFake() {
  // P2 routes are not exercised here — a disabled wrapper keeps them inert.
  return { disabled: true, client: null, ping: async () => { throw new Error('disabled'); } };
}

export async function login(app, username) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login ${username} failed: ${res.body}`);
  return res.headers['set-cookie'].split(';')[0];
}

/**
 * The two standard templates (mirrors prisma/seed-redroid-templates.js):
 * one privileged host-GPU, one non-privileged swiftshader.
 */
export const SEED_TEMPLATES = [
  {
    name: 'redroid-15-gpu-privileged',
    image: 'redroid/redroid:15.0.0',
    androidVersion: '15',
    width: 1080,
    height: 1920,
    dpi: 440,
    fps: 30,
    gpuMode: 'host',
    privileged: true,
    privilegedReason: 'Redroid requires privileged mode for binder/gpu on this host profile (dedicated redroid template, MD §9.2)',
  },
  {
    name: 'redroid-14-swiftshader',
    image: 'redroid/redroid:14.0.0',
    androidVersion: '14',
    width: 720,
    height: 1280,
    dpi: 320,
    fps: 20,
    gpuMode: 'swiftshader_indirect',
    privileged: false,
  },
];

export async function seedRedroidTemplates(app, adminCookie) {
  for (const t of SEED_TEMPLATES) {
    const res = await app.inject({ method: 'POST', url: '/api/redroid/templates', headers: { cookie: adminCookie }, payload: t });
    if (res.statusCode !== 201) throw new Error(`seed template ${t.name}: ${res.statusCode} ${res.body}`);
  }
}
