#!/usr/bin/env node
/**
 * P6 E2E seed — deterministic dev-stack credentials + fixture rows.
 *
 * What it does (all idempotent, safe to re-run):
 *   - users: admin / operator1 / viewer1 ← argon2id(E2E password)
 *     (the live dev stack carried users from P4/P5 with unknown passwords;
 *      the E2E owns these three accounts — the hard-acceptance clean install
 *      wipes the whole DB later and bootstraps a fresh admin via setup:admin)
 *   - provider_configs: 'mock' — a provider row NAMED 'mock' so the schedule
 *     fire-handler's provider join passes; the worker's resolver special-cases
 *     the name 'mock' to the built-in mock provider (never dialed, no key).
 *   - task_definitions: 'E2E nightly check' (fixed UUID so the E2E can
 *     reference it from the UI schedule form)
 *
 * Runs on the HOST (node + local argon2) and talks to postgres through
 * `sg docker -c 'docker compose exec -T postgres psql …'` (postgres has no
 * published host port — MD §13.1 internal network only).
 *
 * Usage: node e2e/seed-e2e.mjs
 */
import { spawnSync } from 'node:child_process';
import argon2 from '@node-rs/argon2';

const { argon2id, hash } = argon2;

export const E2E = {
  base: process.env.E2E_BASE ?? 'http://127.0.0.1:3012',
  username: process.env.E2E_ADMIN ?? 'admin',
  operator: 'operator1',
  viewer: 'viewer1',
  password: process.env.E2E_PASSWORD ?? 'E2ePass12345',
  definitionId: '22222222-2222-4222-8222-222222222222',
  providerId: '11111111-1111-4111-8111-111111111111',
  scheduleName: process.env.E2E_SCHEDULE ?? `e2e-sched-${Date.now() % 100000}`,
};

const REPO = new URL('..', import.meta.url).pathname;

function psql(sql) {
  const r = spawnSync('sg', ['docker', '-c', `cd ${REPO} && docker compose exec -T postgres psql -U app -d water_army -tA -v ON_ERROR_STOP=1`], {
    input: sql,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) {
    throw new Error(`psql failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

async function main() {
  const pw = E2E.password;
  if (pw.length < 12 || !/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) {
    throw new Error(`E2E password fails the platform rule (12+ chars, letters+digits): ${pw}`);
  }
  const h = await hash(pw, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  const usersSql = `
    INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
    VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${E2E.username.replace(/'/g, "''")}', '${h.replace(/'/g, "''")}', 'admin', true, now(), now()),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${E2E.operator}', '${h.replace(/'/g, "''")}', 'operator', true, now(), now()),
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${E2E.viewer}', '${h.replace(/'/g, "''")}', 'viewer', true, now(), now())
    ON CONFLICT (username) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      role = EXCLUDED.role,
      is_active = true,
      updated_at = now();
  `;
  psql(usersSql);
  console.log('users: admin/operator1/viewer1 ← argon2id(E2E password) (upsert)');

  const adminId = psql(`select id from users where username = '${E2E.username}'`);

  // Provider: the schedule fire-handler requires a provider_configs join, so
  // a row NAMED 'mock' must exist (the worker's resolver special-cases the
  // name 'mock' → built-in mock provider, never dialed, no key). Any legacy
  // seed row ('e2e-mock') is superseded.
  psql(`
    INSERT INTO provider_configs (id, name, provider_type, base_url, model_id, encrypted_api_key, timeout_ms, is_enabled, capabilities_json, created_at, updated_at)
    VALUES ('${E2E.providerId}', 'mock', 'openai_compatible', 'http://mock.invalid/v1', 'e2e-mock', NULL, 120000, true, NULL, now(), now())
    ON CONFLICT (name) DO NOTHING;
  `);
  const mockProviderId = psql(`select id from provider_configs where name = 'mock'`);
  if (!mockProviderId) throw new Error("no 'mock' provider row after upsert");

  psql(`
    INSERT INTO task_definitions (id, title, description, task_type, provider_config_id, prompt_template, mode, input_schema_json, output_schema_json, timeout_ms, max_attempts, concurrency_key, requires_approval, created_by, created_at, updated_at)
    VALUES ('${E2E.definitionId}', 'E2E nightly check', 'P6 e2e fixture', 'ai', '${mockProviderId}', 'Report fleet status in one line.', 'analysis_only', NULL, NULL, 60000, 2, NULL, false, '${adminId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}', now(), now())
    ON CONFLICT (id) DO NOTHING;

    -- idempotent re-point (an older seed may have left the definition on a
    -- superseded provider row), then drop the legacy fixture row.
    UPDATE task_definitions SET provider_config_id = '${mockProviderId}', updated_at = now() WHERE id = '${E2E.definitionId}';
    DELETE FROM provider_configs WHERE name = 'e2e-mock';

    -- a second same-KEY definition pair is not needed for the MVP e2e —
    -- the concurrency gate is covered hermetically (task-concurrency-gate.test.js).
  `);
  console.log(`provider_configs: 'mock' (upsert) id=${mockProviderId} (legacy 'e2e-mock' removed)`);
  console.log(`task_definitions: E2E nightly check id=${E2E.definitionId} (upsert)`);
  console.log(JSON.stringify({ ...E2E, adminId }, null, 2));
}

main().catch((err) => {
  console.error(`seed-e2e failed: ${err.message}`);
  process.exit(1);
});
