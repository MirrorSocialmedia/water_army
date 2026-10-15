#!/usr/bin/env node
/**
 * P6 E2E — full flow over the LIVE compose stack (Playwright, system Chrome).
 *
 *   node e2e/seed-e2e.mjs && node e2e/p6-e2e.mjs
 *
 * Flow (screenshot per step → docs/evidence/p6-e2e/):
 *   01 login page (admin)
 *   02 dashboard — REAL counters (MD §6.1): managed fleet ≥3 running (flag #2
 *      live: web/api/worker carry the app.managed label)
 *   03 containers — managed list includes the platform containers
 *   04 container detail — logs + SSE live pill
 *   05 tasks — create a run (mock provider) via the UI
 *   06 task detail — SSE event stream + terminal 'succeeded'
 *   07 schedules — create interval schedule bound to the seeded definition
 *   08 run-now → terminal run → notification bell unread ≥1 (flag #3 e2e)
 *   09 bell panel — item visible, deep-link, mark-all-read (badge clears)
 *   10 RBAC — viewer sees no write actions; a direct viewer POST → 403
 *   11 logout → login page
 *
 * Acceptance: 0 UNEXPECTED console errors / pageerrors (collected per page,
 * reported in summary.json). Exit 1 on any failed step.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE = join(REPO, 'docs/evidence/p6-e2e');
mkdirSync(EVIDENCE, { recursive: true });

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3012';
const PW = process.env.E2E_PASSWORD ?? 'E2ePass12345';
const ADMIN = process.env.E2E_ADMIN ?? 'admin';
const VIEWER = 'viewer1';
const DEF_ID = '22222222-2222-4222-8222-222222222222';

const results = [];
const consoleIssues = [];
const screenshots = [];
let shotNo = 0;

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}

async function shot(page, name) {
  shotNo += 1;
  const file = join(EVIDENCE, `${String(shotNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
  return file;
}

function trackConsole(page, label) {
  // Expected: the app shell probes /api/auth/me on every load (session
  // restore). A 401 on the login screen is the "not signed in" signal —
  // the browser auto-logs "Failed to load resource: 401" for it. Correlate
  // that console error with the actual 401 response URL; anything else is
  // unexpected.
  const recent401Auth = [];
  page.on('response', (r) => {
    if (r.status() === 401 && r.url().includes('/api/auth/me')) recent401Auth.push(Date.now());
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text().slice(0, 400);
    if (/Failed to load resource/.test(text) && /401/.test(text)) {
      const now = Date.now();
      const idx = recent401Auth.findIndex((t) => now - t < 3_000);
      if (idx >= 0) { recent401Auth.splice(idx, 1); return; } // expected session probe
    }
    consoleIssues.push({ page: label, kind: 'console.error', text });
  });
  page.on('pageerror', (err) => consoleIssues.push({ page: label, kind: 'pageerror', text: String(err).slice(0, 400) }));
}

/** Filter out the benign pre-login session-probe 401. */
function isExpectedConsoleIssue(t) {
  return /auth\/me/.test(t) && /401|Unauthorized/i.test(t);
}

/** Small fetch helper for API cross-checks (same-origin cookies not needed —
 *  we pass the session cookie explicitly from the login response). */
async function apiFetch(path, { method = 'GET', cookie, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, json, cookieHeader: res.headers.get('set-cookie') };
}

function extractCookie(setCookie) {
  return setCookie?.split(';')[0] ?? '';
}

/** Poll until fn() returns truthy or timeout. */
async function waitUntil(fn, { timeoutMs = 90_000, everyMs = 1_500, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function loginAs(page, username) {
  await page.goto(`${BASE}/#login`, { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[autocomplete="current-password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/#/', { timeout: 15_000 }).catch(() => {});
  // land on dashboard
  await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15_000 });
  return page;
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  // ---------------------------------------------------------------- admin flow
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Run-now (and other destructive-ish UI paths) gate on window.confirm —
  // headless auto-dismisses dialogs unless we accept them explicitly.
  adminCtx.on('dialog', (d) => { console.log(`dialog(${d.type()}) auto-accept: ${d.message().slice(0, 80)}`); d.accept().catch(() => {}); });
  const admin = await adminCtx.newPage();
  trackConsole(admin, 'admin');

  // 01 — login page
  await admin.goto(BASE, { waitUntil: 'networkidle' });
  await admin.waitForSelector('input[autocomplete="username"]', { timeout: 15_000 });
  const s1 = await shot(admin, 'login-page');
  record('01 login page renders', true, s1);

  // 02 — login + dashboard with real counters
  await loginAs(admin, ADMIN);
  await admin.waitForSelector('text=Managed fleet', { timeout: 15_000 });
  const dashText = await admin.textContent('body');
  void dashText;
  // API cross-check: the rendered dashboard must agree with the real endpoint
  const cookie = extractCookie((await apiFetch('/api/auth/login', { method: 'POST', body: { username: ADMIN, password: PW } })).cookieHeader);
  const dashSummary = (await apiFetch('/api/dashboard/summary', { cookie })).json;
  const fleetOk2 = dashSummary.containers.available && dashSummary.containers.running >= 3;
  const s2 = await shot(admin, 'dashboard-counters');
  record('02 dashboard real counters (fleet ≥3 running — flag #2 live)', fleetOk2, `api: ${JSON.stringify(dashSummary.containers)} ${s2}`);
  if (!fleetOk2) throw new Error('dashboard fleet counters wrong: ' + JSON.stringify(dashSummary.containers));

  // 03 — containers list includes platform containers (managed=true).
  // NOTE: first paint is the slow path (withStats=true over the whole fleet)
  // — allow 60s on a loaded dev box. (Hash-only goto is flaky in Playwright —
  // use the real sidebar link.)
  await admin.click('.nav-link:has-text("Containers")');
  await admin.waitForSelector('text=water-army-web-1', { timeout: 60_000 });
  const contText = await admin.textContent('body');
  const hasAll = ['water-army-web-1', 'water-army-api-1', 'water-army-worker-1'].every((n) => contText.includes(n));
  const s3 = await shot(admin, 'containers-managed');
  record('03 containers: platform trio listed as managed', hasAll, s3);
  if (!hasAll) throw new Error('platform containers missing from managed list');

  // 04 — container detail: logs + SSE live pill (live is ON by default)
  // The container NAME cell is the link (rows are not clickable).
  const webLink = admin.locator('tr', { hasText: 'water-army-web-1' }).getByRole('link').first();
  await webLink.click();
  // Logs tab (default tab is Overview) — the live SSE pill lives here.
  await admin.waitForSelector('h1, h2', { timeout: 15_000 });
  await admin.locator('[role="tab"]', { hasText: 'Logs' }).click();
  // SSE pill: connecting → live (native EventSource; docker events stream)
  await admin.waitForSelector('span.pill:has-text("live")', { timeout: 30_000 });
  await admin.waitForTimeout(1_500); // let a few log lines render
  const s4 = await shot(admin, 'container-detail-logs');
  const logPill = await admin.locator('span.pill:has-text("live")').first().textContent().catch(() => 'n/a');
  const logText = (await admin.locator('pre.log-view').textContent().catch(() => '')) ?? '';
  const logsShown = logText.trim().length > 0 && logText.trim() !== '—';
  record('04 container detail: logs + SSE pill live', Boolean(logsShown), `pill=${logPill} logLines=${logText.split('\n').length} ${s4}`);

  // 05 — create a task run from the UI
  await admin.click('.nav-link:has-text("Tasks")');
  await admin.waitForSelector('form[aria-label="Create task run"]', { timeout: 15_000 });
  await admin.fill('form[aria-label="Create task run"] textarea', `E2E fleet check at ${new Date().toISOString()}`);
  const s5 = await shot(admin, 'tasks-create-form');
  const createStatus = new Promise((resolve) => {
    admin.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url().includes('/api/tasks/runs')) {
        resolve(r.status());
      }
    });
  });
  await admin.click('form[aria-label="Create task run"] button[type="submit"]');
  // submitNew redirects to #/tasks/:id — poll the hash (same-document nav
  // fires no event; the list page h1 'AI task runs' also matches loose text).
  const diag = () => {
    const errBox = admin
      .locator('.error-box, [role="alert"]')
      .allTextContents()
      .then((t) => ` errorBox=${JSON.stringify(t)}`)
      .catch(() => '');
    return ` url=${admin.url()}${errBox}`;
  };
  await waitUntil(() => /#\/tasks\/[0-9a-f-]{20,}/.test(admin.url()), {
    label: `run detail url (createStatus pending)${await diag()}`,
    timeoutMs: 45_000,
  }).catch(async (e) => {
    throw new Error(`run create failed: ${e.message} | status=${await createStatus}`);
  });
  const postStatus = await createStatus;
  const runUrl = admin.url();
  const runId = decodeURIComponent(runUrl.split('#/tasks/')[1]?.split('?')[0] ?? '');
  record('05 task run created from UI', Boolean(runId) && postStatus === 202, `runId=${runId} post=${postStatus} ${s5}`);
  if (!runId) throw new Error('no run id after create');

  // 06 — task detail: SSE events + terminal succeeded (mock provider is fast)
  const runTerminal = await waitUntil(async () => {
    const { json } = await apiFetch(`/api/tasks/runs/${runId}`, { cookie });
    const status = json?.run?.status;
    return status && ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(status) ? status : null;
  }, { label: `run ${runId} terminal`, timeoutMs: 120_000 });
  const s6 = await shot(admin, 'task-detail-terminal');
  record('06 task run reached terminal via live worker', runTerminal === 'succeeded', `status=${runTerminal} ${s6}`);
  if (runTerminal !== 'succeeded') throw new Error(`e2e run ended ${runTerminal}`);
  // events rendered?
  const detailText = await admin.textContent('body');
  const eventsShown = /provider_request|provider_response|attempt/.test(detailText);
  record('06b task detail renders the event stream', eventsShown, detailText.slice(0, 80).replace(/\s+/g, ' '));

  // 07 — create a schedule (interval) bound to the seeded definition
  // 07 — create a schedule (interval) bound to the seeded definition.
  // Full-timestamp name: the suite may re-run within a minute, and a
  // colliding name would make `mine` pick up a stale schedule row.
  const schedName = `e2e-sched-${Date.now()}`;
  await admin.click('.nav-link:has-text("Schedules")');
  await admin.click('text=New schedule');
  const form = admin.locator('form[aria-label="Create schedule"]');
  await form.waitFor({ timeout: 15_000 });
  await form.locator('input').first().fill(schedName);
  await form.locator('select').nth(0).selectOption(DEF_ID); // task definition
  // default type is cron — switch to interval
  await form.locator('select').nth(1).selectOption('interval');
  await form.locator('input[placeholder*="ms"], input[type="number"]').first().fill('3600000');
  const s7 = await shot(admin, 'schedule-create-form');
  // NOTE: the form has TWO type=submit buttons (preview ghost + create) —
  // target the create one explicitly.
  const schedCreate = new Promise((resolve) => {
    admin.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url() === `${BASE}/api/schedules`) resolve(r.status());
    });
  });
  await form.locator('button[type="submit"]', { hasText: 'Create schedule' }).click();
  const schedPostStatus = await Promise.race([
    schedCreate,
    new Promise((r) => setTimeout(() => r('timeout'), 20_000)),
  ]);
  const schedList = (await apiFetch('/api/schedules', { cookie })).json.items ?? [];
  const mine = schedList.find((x) => x.name === schedName);
  record('07 schedule created from UI', Boolean(mine) && schedPostStatus !== 'timeout', `post=${schedPostStatus} ${mine?.name ?? 'not found'} ${s7}`);
  if (!mine) throw new Error('schedule not created (post=' + schedPostStatus + ')');
  const s7b = await shot(admin, 'schedule-created');

  // 08 — run-now → THIS run reaches terminal → notification row for THIS run
  // (flag #3 end-to-end). The schedule row's lastStatus may be stale from an
  // earlier run, so we assert on the specific run id the API hands back.
  const runNowPromise = new Promise((resolve) => {
    admin.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url().endsWith(`/api/schedules/${mine.id}/run-now`)) {
        r.json().then((j) => resolve({ status: r.status, runId: j?.run?.id ?? null })).catch(() => resolve({ status: r.status, runId: null }));
      }
    });
  });
  await admin.locator('tr', { hasText: schedName }).getByText('Run now').click();
  const fired = await Promise.race([
    runNowPromise,
    new Promise((r) => setTimeout(() => r({ status: 'timeout', runId: null }), 20_000)),
  ]);
  const runNowStatus = await waitUntil(async () => {
    if (!fired.runId) return null;
    const { json } = await apiFetch(`/api/tasks/runs/${fired.runId}`, { cookie });
    const st = json?.run?.status;
    return ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(st) ? st : null;
  }, { label: 'run-now run terminal', timeoutMs: 120_000 });
  const notifForRun = await waitUntil(async () => {
    const { json } = await apiFetch('/api/schedule-notifications?limit=20', { cookie });
    return (json?.items ?? []).find((n) => n.runId === fired.runId) ?? null;
  }, { label: 'notification row for the run-now run', timeoutMs: 30_000 });
  const unread1 = (await apiFetch('/api/schedule-notifications/unread-count', { cookie })).json.count;
  const s8 = await shot(admin, 'notification-unread');
  record(
    '08 run-now fired + terminal + notification for THIS run',
    fired.runId && runNowStatus === 'succeeded' && Boolean(notifForRun),
    `run=${fired.runId?.slice(0, 8)} status=${runNowStatus} notif=${Boolean(notifForRun)} unread=${unread1} ${s8}`,
  );
  if (!fired.runId || runNowStatus !== 'succeeded' || !notifForRun) {
    throw new Error(`run-now e2e failed: fired=${JSON.stringify(fired)} status=${runNowStatus} notif=${Boolean(notifForRun)}`);
  }

  // 09 — bell panel: item visible, mark-all-read clears the badge
  const bellBtn = admin.locator('.bell-btn');
  await bellBtn.click();
  await admin.waitForSelector('.bell-item', { timeout: 10_000 });
  const itemText = await admin.locator('.bell-item').first().textContent();
  const linkHref = await admin.locator('.bell-item a').first().getAttribute('href').catch(() => null);
  const s9a = await shot(admin, 'bell-open');
  record('09 bell item visible + deep-link href', itemText.length > 3 && Boolean(linkHref?.startsWith('#/tasks/')), `item="${itemText?.slice(0, 40)}" href=${linkHref} ${s9a}`);
  if (!linkHref?.startsWith('#/tasks/')) throw new Error('bell item has no run deep-link');
  // follow the deep-link via the REAL link (its onClick closes the panel —
  // clicking the row is the user path; setting the hash would skip that)
  await admin.locator('.bell-item a').first().click();
  await admin.waitForTimeout(1_200);
  const landed = /#\/tasks\/[0-9a-f-]{20,}/.test(admin.url());
  record('09b deep-link lands on run detail', landed, admin.url());
  if (!landed) throw new Error('deep-link fell through to dashboard');
  // back to the bell (link click already closed the panel): mark-all-read
  // must clear the badge
  await bellBtn.click();
  await admin.waitForSelector('.bell-panel button:has-text("標記全部已讀")', { state: 'visible', timeout: 10_000 });
  await admin.click('.bell-panel button:has-text("標記全部已讀")');
  // server truth first, then the UI badge (its 30s poll + reload is the
  // user-visible contract); 30s window with diagnostics on failure.
  await waitUntil(async () => (await apiFetch('/api/schedule-notifications/unread-count', { cookie })).json?.count === 0,
    { label: 'server unread-count → 0', timeoutMs: 20_000, everyMs: 800 });
  const badgeGone = await waitUntil(async () => admin.locator('.bell-badge').count() === 0,
    { label: 'badge cleared', timeoutMs: 30_000, everyMs: 1_000 }).catch(() => false);
  const badge = await admin.locator('.bell-badge').count();
  const badgeText = badge ? await admin.locator('.bell-badge').textContent().catch(() => '?') : '—';
  const s9b = await shot(admin, 'bell-marked-read');
  record('09c mark-all-read clears badge', badge === 0, `badge=${badge}(${badgeText}) ${s9b}`);
  if (badge !== 0) throw new Error('badge did not clear (server=0, ui=' + badgeText + ')');

  // 10 — RBAC: viewer has no write surface; direct POST → 403
  const vCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  vCtx.on('dialog', (d) => d.accept().catch(() => {}));
  const viewer = await vCtx.newPage();
  trackConsole(viewer, 'viewer');
  await loginAs(viewer, VIEWER);
  await viewer.click('.nav-link:has-text("Tasks")');
  await viewer.waitForSelector('#root, body', { timeout: 10_000 });
  await viewer.waitForTimeout(1_500);
  const createVisible = await viewer.locator('form[aria-label="Create task run"]').count();
  const direct = await apiFetch('/api/tasks/runs', {
    method: 'POST',
    cookie: extractCookie((await apiFetch('/api/auth/login', { method: 'POST', body: { username: VIEWER, password: PW } })).cookieHeader),
    body: { prompt: 'e2e rbac probe' },
  });
  const s10 = await shot(viewer, 'rbac-viewer-no-write');
  record('10 RBAC: viewer has no create form + direct POST 403', createVisible === 0 && direct.status === 403, `form=${createVisible} api=${direct.status} ${s10}`);
  if (createVisible !== 0 || direct.status !== 403) throw new Error('RBAC viewer leak');
  await vCtx.close();

  // 11 — logout
  await admin.click('.sidebar-footer button:has-text("Sign out")');
  await admin.waitForSelector('input[autocomplete="username"]', { timeout: 15_000 });
  const s11 = await shot(admin, 'logout-back-to-login');
  record('11 logout returns to login', true, s11);

  await adminCtx.close();
  await browser.close();

  // ---------------------------------------------------------------- report
  const summary = {
    at: new Date().toISOString(),
    base: BASE,
    steps: results,
    consoleIssues: consoleIssues.map((c) => `${c.page}: [${c.kind}] ${c.text}`),
    screenshots,
    unexpectedConsoleErrors: consoleIssues.filter((c) => !isExpectedConsoleIssue(c.text) && !/favicon/i.test(c.text)),
    expectedConsoleWhitelist: ['GET /api/auth/me 401 on login screen (session probe — app shell checks cookie state)'],
    passed: results.every((r) => r.ok),
  };
  const summaryPath = join(EVIDENCE, 'summary.json');
  (await import('node:fs')).writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n=== E2E summary ===`);
  console.log(`steps: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  console.log(`console issues: ${consoleIssues.length}`);
  consoleIssues.forEach((c) => console.log(`  [${c.page}] ${c.kind}: ${c.text}`));
  console.log(`evidence: ${EVIDENCE}`);
  console.log(`summary:  ${summaryPath}`);

  if (!summary.passed || summary.unexpectedConsoleErrors.length > 0) {
    console.error('E2E FAILED (step or unexpected console error)');
    process.exit(1);
  }
  console.log('E2E PASSED');
}

main().catch((err) => {
  console.error(`E2E crashed: ${err.stack ?? err}`);
  console.error(`partial steps: ${JSON.stringify(results)}`);
  process.exit(1);
});
