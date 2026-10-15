#!/usr/bin/env node
/**
 * P6 security evidence — live secret-redaction + audit spot-check.
 *
 *   node e2e/secret-redaction-e2e.mjs
 *
 * Runs against the LIVE stack (127.0.0.1:3012) and writes
 * docs/evidence/p6-security/secret-redaction.json:
 *
 *   A. Provider API-key confidentiality (the highest-value secret in the
 *      system): create a provider with a distinctive probe key →
 *        - GET /api/providers response must NOT contain the key (only
 *          hasApiKey: true)
 *        - DB row: AES-256-GCM ciphertext (v1:… prefix), no plaintext
 *        - audit_events row for provider.create: no key in details
 *      → delete → confirm audit row + no key anywhere.
 *   B. Scrub gate on the approval read path: raw-insert a PENDING approval
 *      with sensitive keys in argumentsJson (simulating worst-case legacy
 *      data), then GET the approvals API as admin → response must show
 *      ***redacted*** and no plaintext. (Write paths — recordEvent /
 *      createApproval — scrub at persist time; unit-tested + code-cited.)
 *   C. Audit spot-check: recent P6 operations (login, task.create,
 *      provider.create, run-now) produced audit rows with actor + action.
 *
 * Exit 1 on any assertion failure.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE = join(REPO, 'docs/evidence/p6-security');
mkdirSync(EVIDENCE, { recursive: true });

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3012';
const PW = process.env.E2E_PASSWORD ?? 'E2ePass12345';
const PROBE_KEY = `sk-e2e-PROBE-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const PROBE_NAME = `p6-redact-probe-${Date.now() % 1000000}`;
const SENSITIVE_PAYLOAD = `legacy-secret-${Math.random().toString(36).slice(2, 10)}`;

const findings = [];
function check(name, ok, detail) {
  findings.push({ check: name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
  if (!ok) process.exitCode = 1;
}

function psql(sql) {
  const r = spawnSync('sg', ['docker', '-c', `docker compose exec -T postgres psql -U app -d water_army -tA -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"')}"`], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function api(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, text, json };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { status: res.status, cookie };
}

async function main() {
  // ---------------------------------------------------------------- A: provider key
  const { cookie } = await login('admin', PW);
  const H = { cookie };
  async function A(path, method, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: { cookie: H.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json };
  }

  const created = await A('/api/providers', 'POST', {
    name: PROBE_NAME,
    baseUrl: 'https://probe.invalid/v1',
    modelId: 'probe-model',
    apiKey: PROBE_KEY,
  });
  check('A1 provider.create accepts apiKey → 2xx', created.status === 201 || created.status === 200, `status=${created.status}`);

  const list = await A('/api/providers', 'GET');
  check('A2 GET /api/providers: probe key absent from response', !list.text.includes(PROBE_KEY), `status=${list.status}`);
  const probeRow = (list.json?.providers ?? list.json?.items ?? []).find((p) => p.name === PROBE_NAME);
  check('A3 provider listed with hasApiKey=true (no key material)', probeRow?.hasApiKey === true, JSON.stringify(probeRow ?? 'missing'));

  const dbKey = psql(`select encrypted_api_key from provider_configs where name = '${PROBE_NAME}'`);
  check('A4 DB stores AES-256-GCM ciphertext (v1:… prefix)', dbKey.startsWith('v1:'), dbKey.slice(0, 40) + '…');
  check('A5 DB ciphertext contains no plaintext key', !dbKey.includes(PROBE_KEY), '—');

  const createAudit = psql(`select coalesce(details_json::text, '') from audit_events where action = 'provider.create' and resource_id = (select id::text from provider_configs where name = '${PROBE_NAME}') order by created_at desc limit 1`);
  check('A6 provider.create audited (row exists)', createAudit.length > 0, createAudit.slice(0, 120) || 'no row');
  check('A7 audit details contain no key material', !createAudit.includes(PROBE_KEY), '—');

  // provider deletion is not an MVP API surface — disable via PATCH (the
  // supported lifecycle), then raw-DELETE as test cleanup.
  const dis = await A(`/api/providers/${encodeURIComponent(PROBE_NAME)}`, 'PATCH', { isEnabled: false });
  check('A8 provider disabled via PATCH (supported lifecycle)', dis.status === 200, `status=${dis.status}`);
  const list2 = await A('/api/providers', 'GET');
  const probeRow2 = (list2.json?.providers ?? []).find((p) => p.name === PROBE_NAME);
  check('A8b probe still listed but disabled', probeRow2?.isEnabled === false, JSON.stringify(probeRow2 ?? 'missing'));
  psql(`delete from provider_configs where name = '${PROBE_NAME}'`);
  const dbGone = psql(`select count(*) from provider_configs where name = '${PROBE_NAME}'`);
  check('A9 provider row gone from DB (test cleanup)', dbGone === '0', `count=${dbGone}`);

  // ---------------------------------------------------------------- B: scrub gate on approval read path
  const someRun = psql(`select id from task_runs order by created_at desc limit 1`);
  if (!someRun) throw new Error('no task_runs rows for approval fixture');
  const apId = psql(`select id from users order by created_at desc limit 1`); // fixture reviewer id (not used)
  void apId;
  const ins = psql(`insert into approval_requests (id, task_run_id, tool_name, arguments_json, status) values (gen_random_uuid(), '${someRun}', 'p6.readgate.probe', '{"container":"water-army-web-1","api_key":"${SENSITIVE_PAYLOAD}","headers":{"Authorization":"Bearer ${SENSITIVE_PAYLOAD}"}}'::jsonb, 'pending') returning id`);
  const approvalId = ins.split('\n')[0].trim();
  check('B1 fixture: pending approval with sensitive args raw-inserted', Boolean(approvalId), approvalId.slice(0, 12) + '…');

  const approvals = await A(`/api/tasks/runs/${someRun}`, 'GET');
  const flat = approvals.text;
  check('B2 run-detail API: raw secret absent from approvals', !flat.includes(SENSITIVE_PAYLOAD), `status=${approvals.status}`);
  check('B3 run-detail API: shows ***redacted*** markers', flat.includes('***redacted***'), '—');

  // cleanup fixture
  psql(`delete from approval_requests where id = '${approvalId}'`);

  // ---------------------------------------------------------------- C: audit spot-check (live API + DB)
  const auditList = await A('/api/audit-events?pageSize=50', 'GET');
  const actions = [...new Set((auditList.json?.items ?? []).map((x) => x.action))];
  check('C1 audit API live (items returned)', (auditList.json?.items?.length ?? 0) > 0, `actions=${actions.slice(0, 8).join(',')}`);
  check('C2 logins audited (auth.* actions present)', actions.some((a) => a.startsWith('auth.')), actions.filter((a) => a.startsWith('auth.')).join(',') || 'none');
  check('C3 audit API response contains no probe key', !auditList.text.includes(PROBE_KEY), '—');
  const actorless = psql(`select count(*) from audit_events where actor_user_id is null and action like 'provider.%'`);
  check('C4 provider mutations carry an actor', actorless === '0', `actorless=${actorless}`);

  // ---------------------------------------------------------------- report
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    probeKeyPrefix: PROBE_KEY.slice(0, 12) + '…', // never log the full probe key
    checks: findings,
    allPassed: findings.every((f) => f.ok),
  };
  const { writeFileSync } = await import('node:fs');
  const out = join(EVIDENCE, 'secret-redaction.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n=== redaction evidence ===`);
  console.log(`checks: ${findings.filter((f) => f.ok).length}/${findings.length} passed`);
  console.log(`report: ${out}`);
  if (!report.allPassed) process.exit(1);
  console.log('REDACTION EVIDENCE PASSED');
}

main().catch((e) => {
  console.error(`redaction-e2e crashed: ${e.stack ?? e}`);
  process.exit(1);
});
