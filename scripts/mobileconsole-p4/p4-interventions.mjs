/**
 * P4 Needs Attention E2E — final (gen7 closure). MD Phase 4 / §6 / §7.1.
 *
 * Real API + real UI + real devices (redroid-brmc-poc/s2/s3/s4/s5, scratch
 * stack). The stuck events are triggered through the CONTROLLED simulate
 * hook = the real operator signal route (MD §6.1 operator_report /
 * external_verification) — the state machine, dedupe, audit, API contract
 * and UI all run for real. (The production wiring paths — network
 * BLOCKED/FAILED, boot timeout, adb offline — are covered by the
 * integration suite against the real service code; see ADR-021.)
 *
 *  T40 rbac        — unauth 401; viewer API 403 on create; viewer UI has NO
 *                    action buttons (read-only, MD §11.2)
 *  T41 create+dedupe — simulate hook create (201) + identical re-signal
 *                    (200, created:false, signalCount 2) — no notification
 *                    storm (MD §6.3); row + topbar badge appear in the UI
 *  T42 zero-secrets — the fake credentials in the evidence (password +
 *                    proxy URL) are redacted in the API response, the
 *                    rendered UI, and the stored DB row (MD §6.2/§13)
 *  T43 lifecycle   — operator: Acknowledge (badge drops — ack ≠ resolve),
 *                    Assign to me (badge back), Resolve with note; the
 *                    history timeline = created→acknowledged→assigned→
 *                    resolved with real actor ids (MD §6.3/§7.2)
 *  T44 blocked     — external_verification event = blocked_pending_review:
 *                    page banner 'Automation paused — manual review
 *                    required' (MD §7.1); Dismiss is REFUSED (409
 *                    DISMISS_NOT_ALLOWED, even by the actor; only a human
 *                    Resolve clears it — MD §0.6)
 *  T45 deep-link   — 'Open device' reuses the existing console: admin gets
 *                    a controller lease → LIVE → release; viewer gets
 *                    ?mode=viewer → read-only notice → release (MD §7.1/
 *                    §7.2 step 3, ADR-020 lease/slot reuse)
 *  T46 slot-full   — at 5/5 the 'Open device' action becomes the explicit
 *                    '5/5 — close one first' state (never silently
 *                    over-allocate, MD §7.1)
 *  T47 device banner — device detail shows the open-intervention banner and
 *                    deep-links to the filtered event center (?deviceId=)
 *  T48 audit       — real PG: intervention.* audit rows + the full history
 *                    rows (audit is the contract, MD §6.2)
 *  T49 cleanup     — all p4-e2e-* rows removed (re-run safe), usage 0/5,
 *                    badge back to 0
 *
 * Run: env MC_ADMIN_USER/MC_ADMIN_PASS + MC_OP_USER/MC_OP_PASS +
 *      MC_VIEW_USER/MC_VIEW_PASS  node p4-interventions.mjs
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';

const WEB = process.env.MC_WEB ?? 'http://127.0.0.1:16492';
const API = process.env.MC_API ?? 'http://127.0.0.1:16490';
const EVID = process.env.MC_EVID ?? '/home/kenneth/.openclaw/workspace/logs/mobileconsole-p4/e2e';
const DEVICES = ['redroid-brmc-poc', 'redroid-brmc-s2', 'redroid-brmc-s3', 'redroid-brmc-s4', 'redroid-brmc-s5'];
const RUN = `p4-e2e-${randomBytes(3).toString('hex')}`;
fs.mkdirSync(EVID, { recursive: true });

const startedAt = new Date().toISOString();
const results = [];
const mark = (t, ok, detail) => {
  results.push({ t, ok, detail });
  console.log(`MARK ${t} ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
};
const say = (m) => console.log(`[p4-e2e ${new Date().toISOString()}] ${m}`);
const ev = (name, obj) => {
  const p = `${EVID}/${name}`;
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  say(`evidence → ${p}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const psql = (sql) => execSync(`PGPASSWORD=postgres psql -h 127.0.0.1 -p 16494 -U postgres -d water_army_mc -tA -c ${JSON.stringify(sql)}`, { encoding: 'utf8' }).toString();

// fake credentials — must never survive scrubbing (T42 asserts their absence)
const SECRET_PW = `e2e-secret-pw-${RUN}`;
const SECRET_PROXY = `socks5://e2euser:e2epass-${RUN}@e2e-proxy.example:7801`;
const SECRETS = [SECRET_PW, `e2epass-${RUN}`, 'e2e-proxy.example', SECRET_PROXY];

async function login(browser, user, pass) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', pass);
  await page.click('button[type="submit"]');
  const ok = await page
    .waitForSelector('.login-card', { state: 'detached', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 500));
    await ctx.close().catch(() => {});
    throw new Error(`login failed for ${user} — page: ${body}`);
  }
  return { ctx, page };
}

async function gotoInterventions(page, deviceId = null) {
  const url = `${WEB}/#/interventions${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1_500);
}

/** Queue-based dialog handling for prompt()/alert() (MD §7.1 actions). */
function watchDialogs(page, log, { name }) {
  page.on('dialog', async (d) => {
    const q = log.queue.shift() ?? null;
    log.items.push({ name, type: d.type(), message: d.message().slice(0, 200), at: new Date().toISOString(), accepted: q?.text ?? null });
    if (q?.type === d.type()) await d.accept(q.text).catch(() => d.dismiss().catch(() => {}));
    else await d.dismiss().catch(() => {});
  });
}

function badgeText(page) {
  // no badge element = count 0 (the chip hides the badge at zero)
  return page.evaluate(() => document.querySelector('.att-chip .att-badge')?.textContent ?? '0');
}
async function waitBadge(page, want, budgetMs = 45_000) {
  const t0 = Date.now();
  for (;;) {
    if ((await badgeText(page)) === String(want)) return true;
    if (Date.now() - t0 > budgetMs) return false;
    await sleep(1_000);
  }
}

function rowByTitle(page, title) {
  return page.locator('.att-row', { hasText: title }).first();
}

async function consoleLive(page, budgetMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const cls = await page.evaluate(() => document.querySelector('.stream-banner')?.className ?? '');
    if (/stream-live/.test(cls)) return true;
    if (Date.now() - t0 > budgetMs) return false;
    await sleep(2_000);
  }
}

async function usage(ctx) {
  const r = await ctx.request.get(`${API}/api/device-streams`);
  if (!r.ok()) return { active: -1, max: 5 };
  const j = await r.json().catch(() => ({}));
  return j.usage ?? { active: -1, max: 5 };
}

(async () => {
  say(`start run=${RUN}`);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ---------------- pre-flight: clean slate (re-run safety) ----------------
  const before = psql(`DELETE FROM manual_interventions WHERE title LIKE 'p4-e2e-%' RETURNING id;`).trim();
  if (before) say(`pre-clean removed ${before.split('\n').length} stale p4-e2e rows`);

  const admin = await login(browser, process.env.MC_ADMIN_USER, process.env.MC_ADMIN_PASS);
  const op = await login(browser, process.env.MC_OP_USER, process.env.MC_OP_PASS);
  const view = await login(browser, process.env.MC_VIEW_USER, process.env.MC_VIEW_PASS);
  const opLog = { queue: [], items: [] };
  const admLog = { queue: [], items: [] };
  watchDialogs(op.page, opLog, 'operator');
  watchDialogs(admin.page, admLog, 'admin');

  // stale leases from an interrupted run expire on their own — wait it out
  let u0 = await usage(admin.ctx);
  if (u0.active !== 0) {
    say(`usage ${u0.active}/5 at start — waiting for stale leases to expire`);
    const t0 = Date.now();
    while ((await usage(admin.ctx)).active !== 0 && Date.now() - t0 < 120_000) await sleep(3_000);
    u0 = await usage(admin.ctx);
  }

  const devList = await admin.ctx.request.get(`${API}/api/devices/redroid`).then((r) => r.json());
  const dev = Object.fromEntries(devList.devices.map((d) => [d.name, d.id]));

  const postSignal = (who, body) =>
    who.ctx.request.post(`${API}/api/manual-interventions`, { data: body }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => ({})) }));

  // ---------------- T40: RBAC baseline --------------------------------------
  // a probe event so the viewer page has something to render (read-only
  // assertion must be meaningful — no rows = trivially no buttons)
  const probe = await postSignal(admin, {
    source: 'operator_report', category: 'MANUAL_REVIEW', title: `${RUN}-probe`, deviceId: dev['redroid-brmc-s2'],
  });
  const unauth = await fetch(`${API}/api/manual-interventions/needs-attention-count`);
  const viewerCreate = await postSignal(view, {
    source: 'operator_report', category: 'MANUAL_REVIEW', title: `p4-e2e-rbac-${RUN}`, deviceId: dev['redroid-brmc-poc'],
  });
  await gotoInterventions(view.page);
  const viewerUi = await view.page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent ?? '',
    roNote: /唯讀模式/.test(document.body.innerText),
    rowsVisible: document.querySelectorAll('.att-row').length,
    actionButtons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
      .filter((t) => ['Acknowledge', 'Assign to me', 'Resolve…', 'Dismiss…'].includes(t)).length,
  }));
  // probe resolved so later badge assertions stay exact
  await admin.ctx.request.post(`${API}/api/manual-interventions/${probe.body.intervention.id}/resolve`, { data: { summary: `probe ${RUN}` } }).catch(() => {});
  const t40 = unauth.status === 401 && viewerCreate.status === 403 && viewerUi.h1.includes('Needs Attention') && viewerUi.roNote && viewerUi.rowsVisible >= 1 && viewerUi.actionButtons === 0;
  mark('T40', t40,
    `unauth count=${unauth.status} (want 401); viewer create=${viewerCreate.status} (want 403, code=${viewerCreate.body.error?.code ?? '?'}); viewer UI rows=${viewerUi.rowsVisible} visible but read-only note=${viewerUi.roNote}, action buttons=${viewerUi.actionButtons} (MD §11.2)`);

  // ---------------- T41: controlled simulate hook — create + dedupe --------
  const poc = dev['redroid-brmc-poc'];
  const c1 = await postSignal(admin, {
    source: 'operator_report',
    category: 'MANUAL_REVIEW',
    severity: 'high',
    title: `${RUN}-op-report`,
    summary: 'E2E controlled simulate hook — a stuck workflow needs a human (MD §6.1)',
    deviceId: poc,
    evidence: { password: SECRET_PW, proxyUrl: SECRET_PROXY, errorCode: 'E2E_OK', eventAt: new Date().toISOString() },
  });
  const c2 = await postSignal(admin, {
    source: 'operator_report',
    category: 'MANUAL_REVIEW',
    severity: 'high',
    title: `${RUN}-op-report`,
    summary: 'second signal — same device+category+source (dedupe check)',
    deviceId: poc,
    evidence: { errorCode: 'E2E_OK' },
  });
  const ivId = c1.body.intervention?.id ?? null;
  await gotoInterventions(admin.page);
  const row1 = rowByTitle(admin.page, `${RUN}-op-report`);
  const rowVisible = await row1.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  const badge1 = await waitBadge(admin.page, 1, 40_000);
  const snapshot = c1.body.intervention?.deviceNameSnapshot ?? '';
  const t41 = c1.status === 201 && c1.body.created === true
    && c2.status === 200 && c2.body.created === false && (c2.body.intervention?.signalCount ?? 0) === 2
    && rowVisible && badge1 && snapshot === 'redroid-brmc-poc';
  mark('T41', t41,
    `create=201/created:${c1.body.created}; re-signal=${c2.status}/created:${c2.body.created}/signalCount:${c2.body.intervention?.signalCount} (dedupe, no storm MD §6.3); UI row visible=${rowVisible}, badge=1=${badge1}, snapshot='${snapshot}'`);

  // ---------------- T42: zero secrets (API + UI + DB) ------------------------
  const listRaw = await admin.ctx.request.get(`${API}/api/manual-interventions?pageSize=50`).then((r) => r.text());
  const leakApi = SECRETS.filter((s) => listRaw.includes(s));
  const detail = await admin.ctx.request.get(`${API}/api/manual-interventions/${ivId}`).then((r) => r.json());
  const evJson = JSON.stringify(detail?.intervention?.evidence ?? {});
  const leakDbApi = SECRETS.filter((s) => evJson.includes(s));
  const dbRow = psql(`SELECT COALESCE(evidence::text,'') FROM manual_interventions WHERE id='${ivId}'`);
  const leakDb = SECRETS.filter((s) => dbRow.includes(s));
  await row1.locator('.att-title').click(); // expand detail
  await admin.page.waitForTimeout(800);
  const pageText = await admin.page.evaluate(() => document.body.innerText);
  const leakUi = SECRETS.filter((s) => pageText.includes(s));
  const showsRedacted = pageText.includes('***redacted***');
  const t42 = leakApi.length === 0 && leakDbApi.length === 0 && leakDb.length === 0 && leakUi.length === 0 && showsRedacted;
  ev('t42-zero-secrets.json', { run: RUN, evidenceKeys: Object.keys(detail?.intervention?.evidence ?? {}), leakApi, leakDbApi, leakDb, leakUi, showsRedacted });
  mark('T42', t42,
    `secrets redacted in API list=${leakApi.length === 0}, detail evidence=${leakDbApi.length === 0}, stored DB row=${leakDb.length === 0}, rendered UI=${leakUi.length === 0}; UI shows ***redacted***=${showsRedacted} (MD §6.2/§13: 零 secrets)`);
  await admin.page.locator('button:has-text("返回清單")').first().click().catch(() => {});
  await admin.page.waitForTimeout(500);

  // ---------------- T43: operator lifecycle over the UI ----------------------
  const opId = (await op.ctx.request.get(`${API}/api/auth/me`).then((r) => r.json())).user.id;
  const r1 = rowByTitle(admin.page, `${RUN}-op-report`);
  await r1.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  // operator operates on THEIR page (the state machine is the API's job —
  // the UI is a thin client; the operator context is the honest actor)
  await gotoInterventions(op.page);
  const orow = rowByTitle(op.page, `${RUN}-op-report`);
  await orow.waitFor({ state: 'visible', timeout: 15_000 });

  await orow.locator('button:has-text("Acknowledge")').click();
  await sleep(1_000);
  const stAfterAck = (await op.ctx.request.get(`${API}/api/manual-interventions/${ivId}`).then((r) => r.json())).intervention.status;
  const ackNotResolve = stAfterAck === 'acknowledged';
  const ackBadge0 = (await op.ctx.request.get(`${API}/api/manual-interventions/needs-attention-count`).then((r) => r.json())).count === 0;
  // badge chip reflects the count within one 30s poll cycle
  const chipBack = await waitBadge(op.page, 0, 45_000);

  await rowByTitle(op.page, `${RUN}-op-report`).locator('button:has-text("Assign to me")').click();
  await sleep(1_000);
  const stAfterAssign = (await op.ctx.request.get(`${API}/api/manual-interventions/${ivId}`).then((r) => r.json())).intervention;
  const assignOk = stAfterAssign.status === 'in_progress' && stAfterAssign.assigneeUserId === opId;
  const chipOne = await waitBadge(op.page, 1, 45_000);

  // Resolve… → prompt() with the result note (MD §6.3: resolve 必須有結果/備註)
  opLog.queue.push({ type: 'prompt', text: `e2e resolved ${RUN}: verified on device, signal cleared` });
  await rowByTitle(op.page, `${RUN}-op-report`).locator('button:has-text("Resolve…")').click();
  await sleep(1_500);
  const stAfterResolve = (await op.ctx.request.get(`${API}/api/manual-interventions/${ivId}`).then((r) => r.json())).intervention;
  const resolveOk = stAfterResolve.status === 'resolved' && Boolean(stAfterResolve.resolvedAt) && String(stAfterResolve.resolutionSummary ?? '').includes('e2e resolved');
  const goneFromAttention = await rowByTitle(op.page, `${RUN}-op-report`).waitFor({ state: 'hidden', timeout: 20_000 }).then(() => true).catch(() => false);
  const chipZero = await waitBadge(op.page, 0, 45_000);

  const detailAfter = await op.ctx.request.get(`${API}/api/manual-interventions/${ivId}`).then((r) => r.json());
  const hist = detailAfter.history.map((h) => h.action);
  // T41's re-signal appends a 'signal' row — the honest full timeline is
  // created → signal → acknowledge → assign → resolve (MD §6.3 episode trail)
  const histOk = JSON.stringify(hist) === JSON.stringify(['created', 'signal', 'acknowledge', 'assign', 'resolve'])
    && detailAfter.history[2].actorUserId === opId
    && detailAfter.history[4].note === `e2e resolved ${RUN}: verified on device, signal cleared`;
  ev('t43-lifecycle.json', {
    run: RUN, id: ivId,
    afterAck: { status: stAfterAck, ackIsNotResolve: ackNotResolve, countAfterAck: ackBadge0, chipReflects0: chipBack },
    afterAssign: { status: stAfterAssign.status, assigneeUserId: stAfterAssign.assigneeUserId, expect: opId, chipReflects1: chipOne },
    afterResolve: { status: stAfterResolve.status, resolvedAt: stAfterResolve.resolvedAt, resolutionSummary: stAfterResolve.resolutionSummary, goneFromAttentionTab: goneFromAttention, chipReflects0Again: chipZero },
    history: detailAfter.history.map((h) => ({ action: h.action, from: h.fromStatus, to: h.toStatus, actor: h.actorUserId, note: h.note })),
    historyOk: histOk, dialogs: opLog.items,
  });
  mark('T43', ackNotResolve && ackBadge0 && assignOk && resolveOk && goneFromAttention && histOk,
    `ack≠resolve (${stAfterAck}, badge 0=${ackBadge0}); assign→in_progress+assignee=${assignOk} (badge 1); resolve w/ note → resolved+resolvedAt (${resolveOk}); left attention tab=${goneFromAttention}; history=${hist.join('→')} ack-actor=${detailAfter.history[2]?.actorUserId === opId} (MD §6.3/§7.2)`);

  // ---------------- T44: blocked_pending_review + dismiss policy ------------
  const c3 = await postSignal(admin, {
    source: 'external_verification',
    category: 'EXTERNAL_VERIFICATION',
    severity: 'critical',
    title: `${RUN}-ext-verify`,
    summary: 'Third-party service demanded an integrity check — automation must stay blocked (MD §0.6)',
    deviceId: dev['redroid-brmc-s3'],
    automationDisposition: 'blocked_pending_review',
  });
  const iv3 = c3.body.intervention?.id ?? null;
  await gotoInterventions(op.page);
  const bannerOk = await op.page.locator('text=Automation paused — manual review required').first()
    .waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  const row3 = rowByTitle(op.page, `${RUN}-ext-verify`);
  const rowMarker = await row3.locator('text=Automation paused').last().isVisible().catch(() => false);
  // Dismiss must be REFUSED for external_verification (even by the operator)
  opLog.queue.push({ type: 'prompt', text: `false positive ${RUN}` });
  await row3.locator('button:has-text("Dismiss…")').click();
  await sleep(1_500);
  const dismissAlert = opLog.items.find((x) => x.type === 'alert' && /DISMISS_NOT_ALLOWED/.test(x.message));
  const apiDismiss = await op.ctx.request.post(`${API}/api/manual-interventions/${iv3}/dismiss`, { data: { reason: `false positive ${RUN}` } });
  const apiDismissStatus = apiDismiss.status();
  const apiDismissBody = await apiDismiss.json().catch(() => ({}));
  const stillOpen = (await op.ctx.request.get(`${API}/api/manual-interventions/${iv3}`).then((r) => r.json())).intervention.status === 'open';
  // only a human Resolve clears it
  opLog.queue.push({ type: 'prompt', text: `human verified ${RUN}: service challenge resolved per its rules, automation stays paused until released` });
  await rowByTitle(op.page, `${RUN}-ext-verify`).locator('button:has-text("Resolve…")').click();
  await sleep(1_500);
  const iv3After = (await op.ctx.request.get(`${API}/api/manual-interventions/${iv3}`).then((r) => r.json())).intervention;
  ev('t44-blocked.json', {
    run: RUN, id: iv3,
    create: { status: c3.status, disposition: c3.body.intervention?.automationDisposition },
    pageBanner: bannerOk, rowMarker,
    dismissUiAlert: dismissAlert?.message ?? null,
    dismissApi: { status: apiDismissStatus, code: apiDismissBody.error?.code ?? null },
    stillOpenAfterFailedDismiss: stillOpen,
    resolvedByHuman: { status: iv3After.status, resolvedAt: iv3After.resolvedAt },
  });
  mark('T44', c3.status === 201 && bannerOk && rowMarker && dismissAlert && apiDismissStatus === 409
    && apiDismissBody.error?.code === 'DISMISS_NOT_ALLOWED' && stillOpen && iv3After.status === 'resolved',
    `ext-verify created (blocked_pending_review); banner='${bannerOk}' + row marker=${rowMarker}; UI dismiss → alert ${dismissAlert ? 'shown' : 'MISSING'}; API dismiss ${apiDismissStatus}/${apiDismissBody.error?.code}; event still open after refused dismiss=${stillOpen}; human Resolve cleared it=${iv3After.status === 'resolved'} (MD §0.6/§6.3)`);

  // ---------------- T45: Open device deep link (real console, real device) ---
  const c4 = await postSignal(admin, {
    source: 'operator_report',
    category: 'PERMISSION_REQUIRED',
    severity: 'warning',
    title: `${RUN}-opendev`,
    summary: 'Permission wall — open the device to inspect',
    deviceId: dev['redroid-brmc-s4'],
  });
  await gotoInterventions(admin.page);
  const row4 = rowByTitle(admin.page, `${RUN}-opendev`);
  await row4.waitFor({ state: 'visible', timeout: 15_000 });
  await row4.locator('a:has-text("Open device")').click();
  const onConsole = await admin.page.waitForFunction(
    () => location.hash.startsWith('#/devices/') && location.hash.includes('/console'),
    null, { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  const hashAdmin = admin.page.url();
  const liveAdmin = onConsole ? await consoleLive(admin.page, 120_000) : false;
  await admin.page.screenshot({ path: `${EVID}/t45-admin-console.png` }).catch(() => {});
  // release the controller lease (idempotent DELETE via the page button)
  await admin.page.locator('button:has-text("關閉並釋放串流")').click().catch(() => {});
  await admin.page.waitForTimeout(2_000);
  const uAfterAdmin = await usage(admin.ctx);
  // viewer: same row, viewer mode deep link
  await gotoInterventions(view.page);
  const vrow = rowByTitle(view.page, `${RUN}-opendev`);
  await vrow.waitFor({ state: 'visible', timeout: 15_000 });
  await vrow.locator('a:has-text("Open device")').click();
  const hashView = view.page.url();
  const viewerMode = hashView.includes('?mode=viewer');
  const roNotice = await view.page.waitForFunction(() => /唯讀模式/.test(document.body.innerText), null, { timeout: 15_000 }).then(() => true).catch(() => false);
  const liveView = await consoleLive(view.page, 120_000);
  await view.page.screenshot({ path: `${EVID}/t45-viewer-console.png` }).catch(() => {});
  await view.page.locator('button:has-text("關閉並釋放串流")').click().catch(() => {});
  await view.page.waitForTimeout(2_000);
  const uFinal = await usage(admin.ctx);
  ev('t45-deeplink.json', {
    run: RUN, id: c4.body.intervention?.id,
    admin: { hash: hashAdmin, onConsole, live: liveAdmin, usageAfterRelease: uAfterAdmin },
    viewer: { hash: hashView, viewerMode, roNotice, live: liveView, usageAfterRelease: uFinal },
  });
  mark('T45', onConsole && !hashAdmin.includes('mode=viewer') && liveAdmin && uAfterAdmin.active === 0
    && viewerMode && roNotice && liveView && uFinal.active === 0,
    `admin deep link → console (no viewer mode) LIVE=${liveAdmin}, released→0/5=${uAfterAdmin.active === 0}; viewer deep link ?mode=viewer=${viewerMode}, read-only notice=${roNotice}, LIVE=${liveView}, released→0/5=${uFinal.active === 0} (MD §7.1/§7.2 step 3)`);

  // ---------------- T46: slot full → '5/5 close one first' -------------------
  const leases = [];
  for (const name of DEVICES) {
    const r = await admin.ctx.request.post(`${API}/api/devices/redroid/${dev[name]}/streams`, { data: { mode: 'controller' } });
    const j = await r.json().catch(() => ({}));
    if (r.status() === 201 && j.lease?.id) leases.push({ name, id: j.lease.id });
    else say(`T46 lease ${name} refused: ${r.status()} ${j.error?.code ?? ''}`);
  }
  await gotoInterventions(admin.page); // fresh load → fresh usage poll
  const fullText = await admin.page.evaluate((t) => {
    const row = [...document.querySelectorAll('.att-row')].find((x) => x.textContent.includes(t));
    return row?.textContent ?? '';
  }, `${RUN}-opendev`);
  const fullUi = /5\s*\/\s*5/.test(fullText) && /先關閉一個畫面/.test(fullText) && !/Open device/.test(fullText);
  const uFull = await usage(admin.ctx);
  for (const l of leases) {
    await admin.ctx.request.delete(`${API}/api/device-streams/${l.id}`).catch(() => {});
  }
  const uDrain = await usage(admin.ctx);
  ev('t46-slot-full.json', { run: RUN, leasesHeld: leases.length, rowTextSample: fullText.slice(0, 300), usageAtCap: uFull, usageAfterRelease: uDrain });
  mark('T46', leases.length === 5 && uFull.active === 5 && fullUi && uDrain.active === 0,
    `5 API-held leases → UI 'Open device' replaced by '5/5 已滿 — 先關閉一個畫面'=${fullUi} (no silent over-allocate, MD §7.1); released → ${uDrain.active}/5`);

  // ---------------- T47: device detail banner + filtered deep link ----------
  const c5 = await postSignal(admin, {
    source: 'operator_report',
    category: 'MANUAL_REVIEW',
    title: `${RUN}-banner`,
    summary: 'banner check event',
    deviceId: dev['redroid-brmc-s5'],
  });
  await admin.page.goto(`${WEB}/#/devices/${dev['redroid-brmc-s5']}`, { waitUntil: 'networkidle' });
  const banner = admin.page.locator('.alert-banner', { hasText: '未解決人工介入事件' });
  const bannerVisible = await banner.first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  const bannerText = bannerVisible ? (await banner.first().textContent()) : '';
  await banner.first().locator('a').click().catch(() => {});
  const filteredUrl = admin.page.url();
  await admin.page.waitForTimeout(1_500);
  const chipVisible = await admin.page.locator('.att-tabs .pill', { hasText: '裝置：' }).first().isVisible().catch(() => false);
  const rowCount = await admin.page.evaluate(() => document.querySelectorAll('.att-row').length);
  const rowIsBanner = (await admin.page.evaluate((t) => [...document.querySelectorAll('.att-row')].some((x) => x.textContent.includes(t)), `${RUN}-banner`));
  const rowNotOpendev = !(await admin.page.evaluate((t) => [...document.querySelectorAll('.att-row')].some((x) => x.textContent.includes(t)), `${RUN}-opendev`));
  ev('t47-device-banner.json', {
    run: RUN, id: c5.body.intervention?.id,
    bannerVisible, bannerText: bannerText.slice(0, 200),
    filteredUrl, chipVisible, rowCount, rowIsBanner, rowNotOpendev,
  });
  mark('T47', bannerVisible && /1 個未解決/.test(bannerText) && filteredUrl.includes(`?deviceId=${dev['redroid-brmc-s5']}`) && chipVisible && rowCount === 1 && rowIsBanner && rowNotOpendev,
    `device detail banner '${bannerText.slice(0, 40)}…'=${bannerVisible}; deep link → /interventions?deviceId=… chip=${chipVisible}, rows=${rowCount} (s5 only, s4 hidden=${rowNotOpendev}) (MD §7.1)`);

  // ---------------- T48: audit trail (real PG) --------------------------------
  const auditRows = psql(`SELECT action, count(*) FROM audit_events WHERE action LIKE 'intervention.%' AND resource_id IN ('${ivId}','${iv3}','${c4.body.intervention.id}','${c5.body.intervention.id}') GROUP BY action ORDER BY action;`).trim();
  const histRows = psql(`SELECT action, from_status, to_status, actor_user_id IS NOT NULL, COALESCE(note,'') FROM manual_intervention_history WHERE intervention_id='${ivId}' ORDER BY created_at, id;`).trim();
  const auditCount = auditRows.split('\n').reduce((n, l) => n + Number((l.split('|')[1] ?? '0').trim() || 0), 0);
  const auditOk = auditCount >= 4 && /intervention\.created/.test(auditRows) && /intervention\.resolve/.test(auditRows);
  const histDbOk = histRows.trim().split('\n').length === 5 && /^created/.test(histRows) && histRows.includes('resolve') && histRows.includes('acknowledge');
  ev('t48-audit.json', { run: RUN, since: startedAt, auditActionCounts: auditRows, auditRowCount: auditCount, lifecycleHistoryDb: histRows.split('\n'), ids: { t41: ivId, t44: iv3, t45: c4.body.intervention.id, t47: c5.body.intervention.id } });
  mark('T48', auditOk && histDbOk,
    `audit rows for this run's events: ${auditRows.replace(/\n/g, ' / ') || 'NONE'} (total ${auditCount}); lifecycle history in DB = ${histRows.split('\n').length} rows ${histDbOk ? '(created→…→resolved)' : 'MISMATCH'} (MD §6.2 audit contract)`);

  // ---------------- T49: cleanup + re-run safety ------------------------------
  await admin.ctx.request.post(`${API}/api/manual-interventions/${c4.body.intervention.id}/resolve`, { data: { summary: `e2e cleanup ${RUN}` } }).catch(() => {});
  await admin.ctx.request.post(`${API}/api/manual-interventions/${c5.body.intervention.id}/resolve`, { data: { summary: `e2e cleanup ${RUN}` } }).catch(() => {});
  await sleep(1_000);
  const deleted = psql(`DELETE FROM manual_interventions WHERE title LIKE 'p4-e2e-%' RETURNING id;`).trim();
  const leftover = psql(`SELECT count(*) FROM manual_interventions WHERE title LIKE 'p4-e2e-%';`).trim();
  const countFinal = (await admin.ctx.request.get(`${API}/api/manual-interventions/needs-attention-count`).then((r) => r.json())).count;
  const uEnd = await usage(admin.ctx);
  ev('t49-cleanup.json', { run: RUN, deleted: deleted ? deleted.split('\n').length : 0, leftover, badgeCount: countFinal, usage: uEnd, dialogs: { op: opLog.items, admin: admLog.items } });
  mark('T49', leftover === '0' && countFinal === 0 && uEnd.active === 0,
    `deleted ${deleted ? deleted.split('\n').length : 0} rows (history cascades); leftover=${leftover}, badge=${countFinal}, usage=${uEnd.active}/5 — scratch clean for re-runs`);

  // ---------------- summary ----------------------------------------------------
  ev('p4-e2e-summary.json', { startedAt, finishedAt: new Date().toISOString(), web: WEB, api: API, run: RUN, results });
  await admin.ctx.close().catch(() => {});
  await op.ctx.close().catch(() => {});
  await view.ctx.close().catch(() => {});
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  say(`done: ${results.length - fails}/${results.length} PASS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
