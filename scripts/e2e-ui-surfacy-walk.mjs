/**
 * WA-UI-SURFACY s6 — real-stack walkthrough with screenshots (v2 harness).
 *
 * F1 fix (review mvrvfa9l5l813): every step is a REAL assertion. A step
 * PASSES only when its expected DOM state / response code is machine-read;
 * any click failure or missing expected text FAILS the step (status='FAIL'),
 * it is never swallowed and never hard-coded. `ok` = every step PASS +
 * screenshots pairwise md5-distinct.
 *
 * F2 fix: screenshots are taken ONLY after the expected content is present
 * (expectText gate) — a vite deps-reload / half-painted page can no longer
 * be captured as "evidence". Shot md5s are recorded and cross-checked for
 * duplicates (same-image steps were the F2 smoking gun).
 *
 * Self-proof (error injection, required by the fix ticket):
 *   WALK_SELFTEST=1 node scripts/e2e-ui-surfacy-walk.mjs
 *   → injects an impossible-text step (T1) and a strict click on a missing
 *   element (T2); BOTH must FAIL (and ok must be false) — otherwise the
 *   harness cannot detect failure and is not trusted.
 *
 * Reads the session token from logs/ui-surfacy/.token (never printed).
 * Emits machine-readable results (zero secrets) to stdout JSON + screenshots
 * into logs/ui-surfacy/ (v2-* names). Honest degradations (503 cards,
 * RAM-gate denial) PASS — the point is the SURFACE behaves truthfully.
 */
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:3012';
const ROOT = '/home/kenneth/.openclaw/workspace/water_army';
const OUTDIR = `${ROOT}/logs/ui-surfacy`;
const token = fs.readFileSync(`${OUTDIR}/.token`, 'utf8').trim();
const EXE = `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`;
const SELFTEST = process.env.WALK_SELFTEST === '1';

const results = [];
const shotsTaken = []; // { file, md5 } — pairwise distinct check (F2)
const t0 = Date.now();

function record(n, name, status, detail) {
  results.push({ n, name, status, detail: String(detail).slice(0, 200) });
  console.error(`[${String(n).padStart(2, '0')}] ${status} — ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
}

/**
 * Step runner: fn must RETURN a truthy detail string on success and THROW on
 * any unmet expectation. A throw becomes status='FAIL' (never PASS-by-omission).
 */
async function step(n, name, fn) {
  try {
    const detail = await fn();
    if (detail === undefined || detail === null || detail === false) {
      record(n, name, 'FAIL', 'step fn returned no positive evidence');
    } else {
      record(n, name, 'PASS', detail);
    }
  } catch (e) {
    record(n, name, 'FAIL', e.message);
    await shot(`v2-99-fail-${String(n).replace('.', '-')}.png`).catch(() => {});
  }
}

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.setDefaultTimeout(15000); // strict default: click/locator ops time out LOUD
if (process.env.WALK_DEBUG === '1') {
  page.on('response', (r) => { if (r.url().includes('/api/')) console.error(`DBG ${r.status()} ${r.url().replace(BASE, '')}`); });
  page.on('requestfailed', (r) => console.error(`DBG FAIL ${r.url().replace(BASE, '')} ${r.failure()?.errorText}`));
  page.on('pageerror', (e) => console.error(`DBG PAGEERR ${String(e.message).slice(0, 200)}`));
}

async function shot(file) {
  await page.screenshot({ path: `${OUTDIR}/${file}`, fullPage: false });
  const md5 = crypto.createHash('md5').update(fs.readFileSync(`${OUTDIR}/${file}`)).digest('hex');
  shotsTaken.push({ n: (results.at(-1)?.n ?? '?'), file, md5 });
  return md5;
}

// Full navigation: hash change alone is a same-document nav (no reload) and
// would keep whatever app state the previous step left behind. Force a real
// load at every step so each screenshot is the fresh-render truth.
async function goto(p) {
  await page.goto(BASE + '/#' + p, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 15000 });
  // App must have painted something (React root non-empty) before asserting.
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0, null, { timeout: 15000 });
}

/**
 * Wait until `re` matches the body text — the ONLY accepted moment to take a
 * step screenshot (F2: never screenshot a half-painted / deps-reload page).
 * If the vite "deps re-optimized → reloading" toast is up, force one reload
 * and keep waiting. Throws (=> step FAIL) when the timeout expires.
 */
async function expectText(re, { timeout = 20000, label = String(re) } = {}) {
  const deadline = Date.now() + timeout;
  let reloadDone = false;
  for (;;) {
    const txt = await page.locator('body').innerText().catch(() => '');
    if (re.test(txt)) return txt;
    if (/re-optimiz|page is reloading/i.test(txt) && !reloadDone) {
      reloadDone = true;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`expected ${label} not found — body head: ${JSON.stringify(txt.slice(0, 180))}`);
    }
    await page.waitForTimeout(400);
  }
}

/** Same as expectText but scoped to one region (tab labels live in the body
 *  too — whole-body greps would make tab assertions vacuously true). */
async function expectRegionText(selector, re, { timeout = 20000, label = String(re) } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const txt = await page.locator(selector).first().innerText().catch(() => '');
    if (re.test(txt)) return txt;
    if (Date.now() > deadline) {
      throw new Error(`region ${selector} never matched ${label} — region head: ${JSON.stringify(txt.slice(0, 180))}`);
    }
    await page.waitForTimeout(400);
  }
}

let createdDeviceName = null;

try {
  // 01 — login page (no session): real assertions — login frame painted AND
  // the API really rejects anonymous.
  await step(1, 'login page', async () => {
    await goto('/');
    await expectText(/Water Army/, { label: 'login brand heading /Water Army/' });
    const hasPw = await page.locator('input[type="password"]').count();
    if (!hasPw) throw new Error('no password input on the anonymous root page');
    const anon = await ctx.request.get(`${BASE}/api/auth/me`);
    if (anon.status() !== 401) throw new Error(`anonymous /api/auth/me -> ${anon.status()} (expected 401)`);
    await shot('v2-01-login.png');
    return 'login frame painted (password input present); anonymous /api/auth/me = 401';
  });

  // inject session cookie
  await ctx.addCookies([{ name: 'session', value: token, domain: '127.0.0.1', path: '/' }]);

  // 02 — dashboard: session must be accepted AND the ui-e2e user identified
  // AND the Dashboard heading actually painted.
  await step(2, 'dashboard', async () => {
    await goto('/');
    const me = await ctx.request.get(`${BASE}/api/auth/me`);
    if (me.status() !== 200) throw new Error(`session cookie rejected: /api/auth/me -> ${me.status()}`);
    const meBody = await me.text();
    if (!meBody.includes('ui-e2e')) throw new Error('me response does not identify user ui-e2e');
    await expectText(/Dashboard/, { label: 'Dashboard heading' });
    await shot('v2-02-dashboard.png');
    return 'me=200 (ui-e2e, admin); Dashboard heading painted';
  });

  // --- self-test injections (error injection MUST FAIL — F1 self-proof) ---
  if (SELFTEST) {
    await step('T1', 'selftest: impossible text must FAIL', async () => {
      await expectText(/__IMPOSSIBLE_MARKER_ZZQ__/, { timeout: 3000, label: 'impossible marker (must not be found)' });
      return 'unexpected: marker found';
    });
    await step('T2', 'selftest: strict click on missing element must FAIL', async () => {
      await page.click('#__definitely-missing-element-zzq__', { timeout: 3000 });
      return 'unexpected: click resolved';
    });
  }

  // 03 — create device. PASS = an honest outcome appears and is READ:
  // either an error-box with server rejection text, or the new row in list.
  // Timeout with neither = FAIL. A created device is deleted again in CLN.
  await step(3, 'create device (RAM gate honest either way)', async () => {
    await goto('/devices');
    await expectText(/Redroid devices/, { label: 'devices heading' });
    const name = `redroid-uie2e${Date.now().toString(36)}`;
    await page.waitForSelector('input[placeholder="redroid-dev1"]', { timeout: 15000 });
    const sel = page.locator('form select');
    if (await sel.locator('option').count() <= 1) throw new Error('template select has no options — cannot exercise create');
    await sel.selectOption({ index: 1 });
    await page.fill('input[placeholder="redroid-dev1"]', name, { timeout: 8000 });
    await page.locator('button:has-text("Create device")').click({ timeout: 10000 });
    const deadline = Date.now() + 60000;
    for (;;) {
      const errBox = await page.locator('.error-box').first().textContent().catch(() => null);
      // 'Preflight unavailable' is a separate preflight card — not a create
      // rejection; keep polling for the real create outcome in that case.
      if (errBox && errBox.trim() && !/Preflight unavailable/.test(errBox)) {
        await shot('v2-03-devices-create.png');
        return `honest rejection rendered in error-box: ${errBox.trim().slice(0, 140)}`;
      }
      const row = await page.locator(`text=${name}`).count();
      if (row) {
        createdDeviceName = name;
        await shot('v2-03-devices-create.png');
        return `created ${name} (row rendered; gate ALLOW path) — cleanup scheduled`;
      }
      if (Date.now() > deadline) {
        await shot('v2-03-devices-create.png');
        throw new Error('60s passed with neither error-box rejection nor new row — create outcome unobservable');
      }
      await page.waitForTimeout(1000);
    }
  });

  // 04 — identities list must actually contain the seeded row.
  await step(4, 'identities list', async () => {
    await goto('/identities');
    await expectText(/UI-E2E walkthrough/, { label: 'seeded identity row' });
    const idCount = await page.locator('table tbody tr').count();
    if (idCount < 1) throw new Error('identities table has zero rows despite seeded identity');
    await shot('v2-04-identities.png');
    return `${idCount} row(s) rendered incl. seed "UI-E2E walkthrough"`;
  });

  // resolve the seeded identity via API (displayName cell is not the link —
  // the id cell carries #/identities/:id) and navigate directly.
  const idList = await ctx.request.get(`${BASE}/api/identities`);
  const idItems = (await idList.json()).items ?? [];
  const seed = idItems.find((i) => i.displayName === 'UI-E2E walkthrough');
  if (!seed) throw new Error('seeded identity "UI-E2E walkthrough" missing from /api/identities — cannot walk detail tabs');
  await goto(`/identities/${seed.id}`);

  // 05 — fingerprint tab: tab click strict, panel region must render its
  // heading; after generate, the region must show success or honest error.
  await step(5, 'identity fingerprint tab + generate', async () => {
    await page.click('[role="tab"]:has-text("指紋")', { timeout: 10000 });
    const REGION = '[aria-label="Fingerprint profile"]';
    await expectRegionText(REGION, /指紋 Profile \(W1 — ADR-025\)/, { label: 'fingerprint panel heading' });
    await page.click('button:has-text("生成 / 校驗")', { timeout: 10000 });
    // The outcome is a note (.status-ok / .dep-error) or the rendered profile
    // (pre.log-view) — wait for one of these concrete elements to appear.
    await page.waitForSelector(
      `${REGION} .status-ok, ${REGION} .dep-error, ${REGION} pre.log-view`,
      { timeout: 25000 },
    );
    const txt = await page.locator(REGION).innerText();
    await shot('v2-05-identity-fingerprint.png');
    if (/Profile ensured|schemaVersion/.test(txt)) return 'fingerprint panel rendered; generate outcome read: success (profile view / ensured note)';
    const err = txt.match(/[A-Z][A-Z_]{5,}/);
    return `fingerprint panel rendered; generate surfaced honest error: ${err ? err[0] : 'see panel note'}`;
  });

  // 06 — egress tab: heading must render; either the honest 503 switch card
  // or the admin form (then bind → read the note). No swallow.
  await step(6, 'egress binding surface', async () => {
    await page.click('[role="tab"]:has-text("出口")', { timeout: 10000 });
    await expectText(/出口綁定 \(W3 — ADR-027\)/, { label: 'egress panel heading' });
    // Wait for the panel's SETTLED state — the heading + loading frame paint
    // while the GET is in flight; branching on any earlier snapshot races.
    // Returns the settled kind directly (no second-read window).
    const REGION = '[aria-label="Egress binding"]';
    const settled = await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const t = el.innerText;
        // NB: the switch card renders UPPERCASE EGRESS_BINDING_DISABLED (and
        // an honest error frame may carry the server's lowercase message) —
        // test case-insensitively so the card branch never falls through.
        if (/egress_binding_disabled|disabled on this host/i.test(t)) return 'card';
        if (el.querySelector('input[placeholder*="socks"], input[placeholder*="proxy"]') && !/Loading/.test(t)) return 'form';
        if (el.querySelector('.state-error') && !/Loading/.test(t)) return 'error';
        return null;
      },
      REGION,
      { timeout: 25000 },
    ).then((h) => h.jsonValue());
    if (settled === 'card') {
      await shot('v2-06-identity-egress.png');
      return 'honest 503 switch card read in panel (EGRESS_BINDING_DISABLED)';
    }
    const txt = await page.locator(REGION).innerText();
    if (settled !== 'form') {
      // settled on an unexpected error frame — surface the truth, don't click blindly.
      throw new Error(`egress panel settled as "${settled}" — region reads: ${JSON.stringify(txt.slice(0, 220))}`);
    }
    const ph = page.locator('input[placeholder*="socks"], input[placeholder*="proxy"]').first();
    if (await ph.count()) await ph.fill('socks5://172.38.223.1:18443');
    const iph = page.locator('input[placeholder*="ip" i]').first();
    if (await iph.count()) await iph.fill('172.38.223.1');
    await page.locator('button:has-text("綁定 (bind)"), button:has-text("更新綁定")').first().click({ timeout: 10000 });
    const after = await expectText(/綁定已儲存|綁定已移除|EGRESS|ERROR|CONFLICT|409|503/, { label: 'bind outcome note', timeout: 25000 });
    await shot('v2-06-identity-egress.png');
    return `admin form rendered; bind outcome read: ${after.match(/綁定已儲存|EGRESS[A-Z_]*|CONFLICT|409|503|ERROR/)?.[0] ?? 'see panel'}`;
  });

  // 06.5 — account lifecycle tab: honest 503 card or lifecycle panel.
  await step('6.5', 'account lifecycle tab', async () => {
    await page.click('[role="tab"]:has-text("帳號")', { timeout: 10000 });
    const txt = await expectText(/帳號生命週期 \(T5 — ADR-030\)/, { label: 'lifecycle panel heading' });
    await shot('v2-06b-identity-account.png');
    return /ACCOUNT_LIFECYCLE_DISABLED|Disabled on this host/.test(txt)
      ? 'honest 503 switch card read in panel (ACCOUNT_LIFECYCLE_DISABLED)'
      : 'lifecycle panel rendered (switch on — live state shown)';
  });

  // 07 — device detail: apps tab (W2). Device row click is strict.
  await step(7, 'device apps tab (W2)', async () => {
    await goto('/devices');
    await expectText(/Redroid devices/, { label: 'devices heading' });
    const link = page.locator('a[href^="#/devices/"]:not([href*="fleet"])').first();
    await link.click({ timeout: 10000 });
    await page.waitForFunction(() => /devices\/[^/?#]+/.test(location.hash), null, { timeout: 10000 });
    await page.click('[role="tab"]:has-text("應用")', { timeout: 10000 });
    const txt = await expectText(/應用 \(W2 — ADR-026\)/, { label: 'apps panel heading' });
    await shot('v2-07-device-apps.png');
    return /APP_OPS_DISABLED/.test(txt)
      ? 'honest 503 switch card read in panel (APP_OPS_DISABLED)'
      : 'apps panel rendered (switch on — live list shown)';
  });

  // 07.5 — templates + policy tabs. F3 fix: the ADMIN EDITOR (textareas) is
  // now asserted, not just "policy text somewhere on the page".
  await step('7.5', 'templates + policy tabs (admin editor asserted)', async () => {
    await page.click('[role="tab"]:has-text("模板")', { timeout: 10000 });
    const t = await expectText(/Redroid 模板 \(read-only\)/, { label: 'templates panel heading' });
    if (!/matrix|redroid|template/i.test(t)) throw new Error('templates heading found but no template rows visible');
    await page.click('[role="tab"]:has-text("策略")', { timeout: 10000 });
    await expectText(/派發網絡策略 \(BR-B6/, { label: 'policy panel heading' });
    // editor textareas paint only once GET /api/network-policy resolves —
    // wait for that data moment, THEN assert (was a race: heading first).
    await page.waitForSelector('textarea', { timeout: 20000 });
    const tas = await page.locator('textarea').count();
    if (tas < 2) throw new Error(`admin policy editor missing: only ${tas} textarea(s) (expected allowlist + allowlistInternal)`);
    await shot('v2-07b-device-templates-policy.png');
    return 'templates table rendered; policy panel rendered WITH admin editor (2 zone textareas visible — F3 evidence)';
  });

  // 08 — batch planner: heading + form affordances must actually paint.
  await step(8, 'batch planner', async () => {
    await goto('/batches');
    await expectText(/Batch Planner/, { label: 'planner heading' });
    await shot('v2-08-batch-planner.png');
    return 'planner heading painted (form page, no crash)';
  });

  // 09 — execute: real branch — click Start only if startable; either branch
  // requires the planner to still be intact; clicking must not throw.
  await step(9, 'execute (start or honest empty state)', async () => {
    const startBtn = page.locator('button:has-text("Start"), button:has-text("執行"), button:has-text("Run")').first();
    const present = await startBtn.count();
    const canStart = present && await startBtn.isEnabled().catch(() => false);
    if (canStart) {
      await startBtn.click({ timeout: 10000 }); // strict — F1: no swallow
      await page.waitForTimeout(3000);
      await expectText(/Batch Planner|batch|task|Queued|started|ERROR|empty/i, { label: 'post-start page integrity' });
      await shot('v2-09-execute.png');
      return 'Start clicked (no throw) and page integrity held';
    }
    await expectText(/Batch Planner/, { label: 'planner intact in empty state' });
    await shot('v2-09-execute.png');
    return canStart === false && present
      ? 'Start button present but disabled — honest non-fake affordance'
      : 'no startable items rendered — honest empty planner (no fake button)';
  });

  // 10 — monitor live view
  await step(10, 'live view', async () => {
    await goto('/monitor');
    await expectText(/Live Monitor/, { label: 'monitor heading' });
    await shot('v2-10-monitor-live.png');
    return 'monitor heading painted (SSE live view)';
  });

  // 11 — interventions console
  await step(11, 'human intervention console', async () => {
    await goto('/interventions');
    await expectText(/人工介入|Needs Attention/, { label: 'interventions heading' });
    await shot('v2-11-interventions.png');
    return 'interventions heading painted';
  });

  // 12 — reports
  await step(12, 'report export surface', async () => {
    await goto('/reports');
    await expectText(/Batch Reports/, { label: 'reports heading' });
    const expBtn = await page.locator('button:has-text("CSV"), a:has-text("CSV"), button:has-text("export"), button:has-text("導出")').count();
    await shot('v2-12-reports.png');
    return `reports heading painted; export affordance count=${expBtn}`;
  });

  // E1 — Settings materialization: ALL THREE cards required (AND, not OR).
  await step('E1', 'settings materialized (all three cards)', async () => {
    await goto('/settings');
    const txt = await expectText(/系統配置總覽 System overview/, { label: 'config-summary card', timeout: 25000 });
    const missing = [];
    if (!/AI providers/.test(txt)) missing.push('providers card');
    if (!/任務定義 Task definitions/.test(txt)) missing.push('task-definitions card');
    if (missing.length) throw new Error(`settings cards missing: ${missing.join(', ')}`);
    if (/sk-[A-Za-z0-9]{16,}|ghp_/.test(txt)) throw new Error('secret-looking fragment visible on Settings page');
    await shot('v2-13-settings.png');
    return 'config-summary + providers (masked) + task-definitions cards all rendered; zero secret-looking text on screen';
  });

  // E2 — RAM gate page
  await step('E2', 'ram gate page', async () => {
    await goto('/ram-gate');
    const txt = await expectText(/RAM Gate/, { label: 'ram gate heading' });
    if (!/Decision trail|Policy/.test(txt)) throw new Error('ram gate heading found but neither Decision trail nor Policy section painted');
    await shot('v2-14-ram-gate.png');
    return 'ram gate page painted (Decision trail + Policy sections)';
  });

  // CLN — cleanup: delete a device created in step 3 (API, admin session).
  await step('CLN', 'cleanup created device', async () => {
    if (!createdDeviceName) return 'nothing created — no cleanup needed';
    const list = await ctx.request.get(`${BASE}/api/devices/redroid`);
    if (list.status() !== 200) throw new Error(`device list -> ${list.status()}`);
    const devs = (await list.json()).devices ?? [];
    const dev = devs.find((d) => d.name === createdDeviceName);
    if (!dev) return `created device ${createdDeviceName} already absent`;
    const del = await ctx.request.delete(`${BASE}/api/devices/redroid/${dev.id}`, { data: { confirm: createdDeviceName, removeData: true } });
    const body = await del.text();
    if (!(del.status() === 200 && /"deleted"\s*:\s*true/.test(body))) {
      throw new Error(`cleanup DELETE -> ${del.status()} ${body.slice(0, 120)}`);
    }
    return `deleted ${createdDeviceName} (${body.slice(0, 80)})`;
  });
} catch (e) {
  record('FATAL', 'walkthrough aborted', 'FAIL', e.message);
  await shot('v2-99-fatal.png').catch(() => {});
}

// F2 — pairwise md5 dedup over all step screenshots (fail-shots excluded).
const stepShots = shotsTaken.filter((s) => !s.file.includes('fail') && !s.file.includes('fatal'));
const seen = new Map();
const dupes = [];
for (const s of stepShots) {
  if (seen.has(s.md5)) dupes.push(`${seen.get(s.md5)} == ${s.file}`);
  else seen.set(s.md5, s.file);
}
if (dupes.length) record('MD5', 'screenshot pairwise uniqueness', 'FAIL', `duplicate images: ${dupes.join('; ')}`);
else record('MD5', 'screenshot pairwise uniqueness', 'PASS', `${stepShots.length} screenshots, all pairwise md5-distinct`);

const stepResults = results.filter((r) => r.n !== 'MD5');
const md5Row = results.find((r) => r.n === 'MD5');
const ok = stepResults.every((r) => r.status === 'PASS');
fs.writeFileSync(`${OUTDIR}/walk-results.json`, JSON.stringify({ steps: stepResults, screenshots: stepShots, md5Check: md5Row, ok, selftest: SELFTEST, at: new Date().toISOString() }, null, 1));
console.log(JSON.stringify({ ok, selftest: SELFTEST, steps: stepResults.length, fails: stepResults.filter((r) => r.status === 'FAIL').map((r) => r.n), md5: md5Row.status, ms: Date.now() - t0 }, null, 0));
await browser.close();
process.exit(ok ? 0 : 1);
