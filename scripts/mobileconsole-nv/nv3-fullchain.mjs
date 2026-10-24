/**
 * NV3 (gen9, 2026-10-24) — Manual-intervention FULL-CHAIN E2E.
 *
 * Boss decision 2026-10-24 14:09 (NV3): "補一項端到端測試 — 受控測試事件 →
 * 事件產生 → 後端記錄 → 管理頁提示 → **點擊通知開啟正確手機** → 人工處理後
 * 狀態更新，全鏈正常；唔好依賴第三方 App 自然觸發作唯一測試方法。"
 *
 * This is the single continuous chain the boss specified, with the one
 * assertion T45 (P4) did NOT make explicit: the console opened from the
 * notification is the CORRECT device (URL deviceId === event deviceId AND
 * the console header shows the event device's name).
 *
 *  NV3-1 controlled event — operator_report simulate hook → 201, device s3
 *  NV3-2 backend record   — API detail + real PG row + audit row
 *  NV3-3 notification     — admin dashboard: topbar badge appears (poll ≤30s)
 *  NV3-4 click notification — click the topbar chip (the notification) →
 *                            event center → row → 'Open device' → console URL
 *                            carries the EVENT device's id (exact match) and
 *                            the console header shows that device's name
 *  NV3-5 correct phone LIVE — stream banner LIVE (screencap) + the only active
 *                            lease is bound to the event device
 *  NV3-6 manual handling  — operator (real actor): Acknowledge (ack ≠ resolve)
 *                            → Assign to me → Resolve… (note required)
 *  NV3-7 status update    — status open→…→resolved, resolvedAt set, full
 *                            history timeline, needs-attention count → 0
 *                            (API + UI badge + row gone + device banner gone)
 *  NV3-8 cleanup          — console lease released (usage 0/5), rows removed
 *                            (re-run safe)
 *
 * Real API + real UI (Playwright) + real devices (screencap frames).
 * Run: MC_ADMIN_USER/MC_ADMIN_PASS (env.sh) + MC_OP_USER/MC_OP_PASS
 *      node nv3-fullchain.mjs
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';

const WEB = process.env.MC_WEB ?? 'http://127.0.0.1:16492';
const API = process.env.MC_API ?? 'http://127.0.0.1:16490';
const EVID = process.env.MC_EVID ?? '/home/kenneth/.openclaw/workspace/logs/mobileconsole-nv/e2e';
const EVENT_DEVICE = 'redroid-brmc-s3'; // the device the event is about
const RUN = `nv3-${randomBytes(3).toString('hex')}`;
fs.mkdirSync(EVID, { recursive: true });

const startedAt = new Date().toISOString();
const results = [];
const mark = (t, ok, detail) => {
  results.push({ t, ok, detail });
  console.log(`MARK ${t} ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
};
const say = (m) => console.log(`[nv3-e2e ${new Date().toISOString()}] ${m}`);
const ev = (name, obj) => {
  const p = `${EVID}/${name}`;
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  say(`evidence → ${p}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPsqlTag = (l) => /^(INSERT|UPDATE|DELETE|SELECT|CREATE|DROP|ALTER|SET|COMMIT|ROLLBACK|TRUNCATE|GRANT|COPY|COMMENT) (0|1|\d+)( .*)?$/.test(l.trim());
// NOTE (2026-10-24 incident): psql -tA still prints DML command tags
// ("DELETE 0") on stdout even with no rows — a naive non-empty check reads
// that as "1 row affected" (the NV "phantom row" false positive, which the
// write-trap investigation conclusively ruled out: table was always empty).
const psql = (sql) => execSync(`PGPASSWORD=postgres psql -h 127.0.0.1 -p 16494 -U postgres -d water_army_mc -tA`, { encoding: 'utf8', input: sql }).toString().trim().split('\n').filter((l) => l && !isPsqlTag(l)).join('\n');

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

/** Queue-based dialog handling (prompt/alert — MD §7.1 actions). */
function watchDialogs(page, log, { name }) {
  page.on('dialog', async (d) => {
    const q = log.queue.shift() ?? null;
    log.items.push({ name, type: d.type(), message: d.message().slice(0, 200), accepted: q?.text ?? null });
    if (q?.type === d.type()) await d.accept(q.text).catch(() => d.dismiss().catch(() => {}));
    else await d.dismiss().catch(() => {});
  });
}

function badgeText(page) {
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
  if (!r.ok()) return { active: -1, max: 5, leases: [] };
  const j = await r.json().catch(() => ({}));
  return { ...(j.usage ?? { active: -1, max: 5 }), leases: (j.leases ?? []).filter((l) => l.status === 'ACTIVE') };
}

(async () => {
  say(`start run=${RUN} (event device: ${EVENT_DEVICE})`);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // ---- pre-flight: re-run safety + clean slate --------------------------------
  // (2026-10-24: phantom-row investigation — log full row identity before delete;
  //  PG statement logging is ON for this scratch run, docker logs mc-scratch-pg)
  const phantoms = psql(`SELECT id, title, status, source, device_id, to_char(created_at,'HH24:MI:SS') FROM manual_interventions WHERE title LIKE 'nv3-e2e-%';`);
  if (phantoms) say(`pre-clean phantoms: ${JSON.stringify(phantoms.split('\n'))}`);
  const histPhantoms = psql(`SELECT intervention_id, action, actor_user_id FROM manual_intervention_history h WHERE EXISTS (SELECT 1 FROM manual_interventions i WHERE i.id = h.intervention_id AND i.title LIKE 'nv3-e2e-%');`);
  if (histPhantoms) say(`pre-clean history phantoms: ${JSON.stringify(histPhantoms.split('\n'))}`);
  const before = psql(`DELETE FROM manual_interventions WHERE title LIKE 'nv3-e2e-%' RETURNING id;`);
  if (before) say(`pre-clean removed ${before.split('\n').length} stale nv3-e2e rows`);

  const admin = await login(browser, process.env.MC_ADMIN_USER, process.env.MC_ADMIN_PASS);
  const op = await login(browser, process.env.MC_OP_USER, process.env.MC_OP_PASS);
  const opLog = { queue: [], items: [] };
  const admLog = { queue: [], items: [] };
  watchDialogs(op.page, opLog, 'operator');
  watchDialogs(admin.page, admLog, 'admin');

  let u0 = await usage(admin.ctx);
  if (u0.active !== 0) {
    say(`usage ${u0.active}/5 at start — waiting for stale leases to expire`);
    const t0 = Date.now();
    while ((await usage(admin.ctx)).active !== 0 && Date.now() - t0 < 120_000) await sleep(3_000);
    u0 = await usage(admin.ctx);
  }

  const devList = await admin.ctx.request.get(`${API}/api/devices/redroid`).then((r) => r.json());
  const dev = Object.fromEntries(devList.devices.map((d) => [d.name, d.id]));
  const eventDeviceId = dev[EVENT_DEVICE];
  if (!eventDeviceId) throw new Error(`device ${EVENT_DEVICE} not in API list`);
  const opId = (await op.ctx.request.get(`${API}/api/auth/me`).then((r) => r.json())).user.id;
  const postSignal = (who, body) =>
    who.ctx.request.post(`${API}/api/manual-interventions`, { data: body }).then(async (r) => ({ status: r.status(), body: await r.json().catch(() => ({})) }));

  // ---------------- NV3-1: controlled event (simulate hook) ----------------------
  const c1 = await postSignal(admin, {
    source: 'operator_report',
    category: 'PERMISSION_REQUIRED',
    severity: 'high',
    title: `nv3-e2e-${RUN}`,
    summary: 'NV3 full-chain: a stuck workflow on the s3 device needs a human (MD §6.1 operator_report controlled path)',
    deviceId: eventDeviceId,
    evidence: { errorCode: 'NV3_E2E', eventAt: new Date().toISOString() },
  });
  const iv = c1.body.intervention ?? {};
  const nv31 = c1.status === 201 && c1.body.created === true
    && iv.status === 'open' && iv.deviceNameSnapshot === EVENT_DEVICE;
  mark('NV3-1', nv31,
    `controlled event: create=${c1.status}/created:${c1.body.created}, status=${iv.status}, deviceNameSnapshot='${iv.deviceNameSnapshot}' (want ${EVENT_DEVICE})`);
  ev('nv3-1-create.json', { run: RUN, status: c1.status, created: c1.body.created, intervention: iv });

  // ---------------- NV3-2: backend record (API + PG + audit) ----------------------
  const detail0 = await admin.ctx.request.get(`${API}/api/manual-interventions/${iv.id}`).then((r) => r.json());
  const h0 = (detail0.history ?? []).map((h) => h.action);
  const dbRow = psql(`SELECT status, source, category, device_id, signal_count, dedupe_key FROM manual_interventions WHERE id='${iv.id}';`);
  const [dbStatus, dbSource, dbCategory, dbDeviceId, dbSignal, dbDedupe] = dbRow.split('|');
  const auditN = Number(psql(`SELECT count(*) FROM audit_events WHERE action='intervention.created' AND resource_id='${iv.id}';`) || 0);
  const nv32 = h0[0] === 'created' && dbStatus === 'open' && dbDeviceId === eventDeviceId
    && dbSource === 'operator_report' && Number(dbSignal) === 1 && auditN >= 1;
  mark('NV3-2', nv32,
    `backend record: API history[0]=${h0[0]} (want created); PG row status=${dbStatus} device_id match=${dbDeviceId === eventDeviceId} source=${dbSource} signal=${dbSignal}; audit intervention.create rows=${auditN}`);
  ev('nv3-2-record.json', { run: RUN, id: iv.id, apiHistory: h0, pgRow: { dbStatus, dbSource, dbCategory, dbDeviceId, dbSignal, dbDedupe }, auditCreateRows: auditN });

  // ---------------- NV3-3: notification appears (admin dashboard) -----------------
  await admin.page.goto(`${WEB}/#/`, { waitUntil: 'networkidle' }); // dashboard — fresh eyes
  await admin.page.waitForTimeout(1_500);
  const badgeSeen = await waitBadge(admin.page, 1, 40_000);
  const chipHref = await admin.page.locator('.att-chip').getAttribute('href').catch(() => null);
  mark('NV3-3', badgeSeen && chipHref === '#/interventions',
    `notification: dashboard topbar badge=1 appeared=${badgeSeen} (30s poll), chip href='${chipHref}' (deep link to event center)`);

  // ---------------- NV3-4: click the notification → correct phone -----------------
  await admin.page.locator('.att-chip').first().click(); // THE notification click
  const onEventCenter = await admin.page.waitForFunction(() => location.hash.startsWith('#/interventions'), null, { timeout: 10_000 })
    .then(() => true).catch(() => false);
  const row1 = rowByTitle(admin.page, `nv3-e2e-${RUN}`);
  const rowVisible = await row1.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  await row1.locator('a:has-text("Open device")').click();
  const onConsole = await admin.page.waitForFunction(() => location.hash.startsWith('#/devices/') && location.hash.includes('/console'), null, { timeout: 10_000 })
    .then(() => true).catch(() => false);
  // hash nav re-render is async — wait for the console to actually render
  // (stream-banner mount) before asserting its header (run-3 race: h1 read
  // while the Interventions page was still in the DOM)
  const consoleRendered = onConsole ? await admin.page.waitForSelector('.stream-banner', { timeout: 30_000 }).then(() => true).catch(() => false) : false;
  const consoleUrl = admin.page.url();
  // THE assertion T45 never made explicit: the opened console is the EVENT device
  const urlIsEventDevice = consoleUrl.includes(`/devices/${eventDeviceId}/console`);
  const h1 = onConsole ? (await admin.page.locator('h1').first().textContent().catch(() => '')) : '';
  const headerIsEventDevice = h1.startsWith(EVENT_DEVICE);
  mark('NV3-4', onEventCenter && rowVisible && onConsole && consoleRendered && urlIsEventDevice && headerIsEventDevice,
    `click notification: chip→event center=${onEventCenter}, row visible=${rowVisible}, 'Open device'→console=${onConsole} (rendered=${consoleRendered}); URL device match=${urlIsEventDevice} (url=…${consoleUrl.slice(-60)}), console header='${h1}' (want ${EVENT_DEVICE} …) — 開嘅係 event 嗰部機`);
  ev('nv3-4-deeplink.json', { run: RUN, id: iv.id, consoleUrl, urlIsEventDevice, consoleHeader: h1, headerIsEventDevice, eventDeviceId });

  // ---------------- NV3-5: correct phone LIVE (screencap) --------------------------
  const live = onConsole ? await consoleLive(admin.page, 120_000) : false;
  await admin.page.screenshot({ path: `${EVID}/nv3-5-console-live.png` }).catch(() => {});
  const uLive = await usage(admin.ctx);
  const leaseOnEventDevice = uLive.leases.length === 1 && uLive.leases[0].deviceId === eventDeviceId;
  const leaseOwner = uLive.leases[0]?.userId;
  const adminId = (await admin.ctx.request.get(`${API}/api/auth/me`).then((r) => r.json())).user.id;
  const nv35 = live && uLive.active === 1 && leaseOnEventDevice && leaseOwner === adminId;
  mark('NV3-5', nv35,
    `correct phone LIVE: stream-live=${live} (screencap), usage=${uLive.active}/5, the single ACTIVE lease is bound to the event device=${leaseOnEventDevice} (owner=admin=${leaseOwner === adminId})`);
  ev('nv3-5-live.json', { run: RUN, live, usage: uLive.usage, activeLeases: uLive.leases });

  // ---------------- NV3-6: manual handling (operator = real actor) -----------------
  const opPage = op.page;
  await opPage.goto(`${WEB}/#/interventions`, { waitUntil: 'networkidle' });
  const orow = rowByTitle(opPage, `nv3-e2e-${RUN}`);
  await orow.waitFor({ state: 'visible', timeout: 20_000 });

  await orow.locator('button:has-text("Acknowledge")').click();
  await sleep(1_200);
  const dAck = await op.ctx.request.get(`${API}/api/manual-interventions/${iv.id}`).then((r) => r.json());
  const ackOk = dAck.intervention.status === 'acknowledged'
    && (await op.ctx.request.get(`${API}/api/manual-interventions/needs-attention-count`).then((r) => r.json())).count === 0;

  await rowByTitle(opPage, `nv3-e2e-${RUN}`).locator('button:has-text("Assign to me")').click();
  await sleep(1_200);
  const dAssign = await op.ctx.request.get(`${API}/api/manual-interventions/${iv.id}`).then((r) => r.json());
  const assignOk = dAssign.intervention.status === 'in_progress' && dAssign.intervention.assigneeUserId === opId;

  const RESOLVE_NOTE = `nv3 resolved ${RUN}: inspected the s3 device via the console opened from the notification — permission wall cleared, signal gone`;
  opLog.queue.push({ type: 'prompt', text: RESOLVE_NOTE });
  await rowByTitle(opPage, `nv3-e2e-${RUN}`).locator('button:has-text("Resolve…")').click();
  await sleep(1_500);
  const dResolve = await op.ctx.request.get(`${API}/api/manual-interventions/${iv.id}`).then((r) => r.json());
  const resolveOk = dResolve.intervention.status === 'resolved' && Boolean(dResolve.intervention.resolvedAt)
    && String(dResolve.intervention.resolutionSummary ?? '').includes(`nv3 resolved ${RUN}`);
  await opPage.screenshot({ path: `${EVID}/nv3-6-resolved.png` }).catch(() => {});
  mark('NV3-6', ackOk && assignOk && resolveOk,
    `manual handling (operator ${opId.slice(0, 8)}…): ack→acknowledged + count 0=${ackOk}; assign→in_progress+assignee=${assignOk}; resolve(note)→resolved+resolvedAt+summary=${resolveOk}`);
  ev('nv3-6-lifecycle.json', {
    run: RUN, id: iv.id, operator: opId,
    ack: { status: dAck.intervention.status, countAfterAck: ackOk },
    assign: { status: dAssign.intervention.status, assigneeUserId: dAssign.intervention.assigneeUserId },
    resolve: { status: dResolve.intervention.status, resolvedAt: dResolve.intervention.resolvedAt, resolutionSummary: dResolve.intervention.resolutionSummary },
  });

  // ---------------- NV3-7: status update + count reset (all surfaces) -------------
  const countFinal = (await op.ctx.request.get(`${API}/api/manual-interventions/needs-attention-count`).then((r) => r.json())).count;
  const rowGone = await rowByTitle(opPage, `nv3-e2e-${RUN}`).waitFor({ state: 'hidden', timeout: 20_000 }).then(() => true).catch(() => false);
  const badgeZero = await waitBadge(opPage, 0, 45_000); // UI surface (30s poll)
  const hist = (await op.ctx.request.get(`${API}/api/manual-interventions/${iv.id}`).then((r) => r.json())).history.map((h) => h.action);
  const histOk = JSON.stringify(hist) === JSON.stringify(['created', 'acknowledge', 'assign', 'resolve'])
    && (await op.ctx.request.get(`${API}/api/manual-interventions/${iv.id}`).then((r) => r.json())).history[1].actorUserId === opId;
  // device banner surface: the event device's detail page must no longer show
  // the open-intervention banner
  await admin.page.goto(`${WEB}/#/devices/${eventDeviceId}`, { waitUntil: 'networkidle' });
  await admin.page.waitForTimeout(1_500);
  const bannerGone = !(await admin.page.locator('.alert-banner', { hasText: '未解決人工介入事件' }).first().isVisible().catch(() => false));
  const dbFinal = psql(`SELECT status, resolved_at IS NOT NULL, assignee_user_id FROM manual_interventions WHERE id='${iv.id}';`);
  mark('NV3-7', countFinal === 0 && rowGone && badgeZero && histOk && bannerGone && dbFinal.startsWith('resolved|t'),
    `status update: count API=${countFinal} (want 0), row gone=${rowGone}, UI badge 0=${badgeZero}, history=${JSON.stringify(hist)} (actors=operator=${histOk}), device banner gone=${bannerGone}, PG='${dbFinal}'`);
  ev('nv3-7-status.json', { run: RUN, countFinal, rowGone, badgeZero, history: hist, bannerGone, pg: dbFinal });

  // ---------------- NV3-8: cleanup (lease released, rows removed) ------------------
  // release the console lease (opened in NV3-5) via the page button
  await admin.page.goto(`${WEB}/#/devices/${eventDeviceId}/console`, { waitUntil: 'networkidle' });
  await admin.page.waitForTimeout(2_000);
  await admin.page.locator('button:has-text("關閉並釋放串流")').click().catch(() => {});
  await sleep(2_000);
  const uEnd = await usage(admin.ctx);
  const delHist = psql(`DELETE FROM manual_intervention_history WHERE intervention_id='${iv.id}' RETURNING id;`);
  const delIv = psql(`DELETE FROM manual_interventions WHERE id='${iv.id}' RETURNING id;`);
  const leftover = psql(`SELECT count(*) FROM manual_interventions WHERE title LIKE 'nv3-e2e-%';`);
  const nv38 = uEnd.active === 0 && leftover === '0' && Boolean(delIv);
  mark('NV3-8', nv38,
    `cleanup: usage ${uEnd.active}/5 (want 0), intervention rows deleted=${Boolean(delIv)} (history ${delHist ? delHist.split('\n').length : 0}), leftover nv3-e2e rows=${leftover} (re-run safe)`);
  ev('nv3-8-cleanup.json', { run: RUN, usage: uEnd.usage, deleted: { iv: Boolean(delIv), history: delHist ? delHist.split('\n').length : 0 }, leftover });

  ev('nv3-summary.json', {
    startedAt,
    finishedAt: new Date().toISOString(),
    run: RUN,
    chain: 'controlled event → backend record → notification → click → correct phone LIVE → manual resolve → status+count reset',
    results,
  });
  await admin.ctx.close().catch(() => {});
  await op.ctx.close().catch(() => {});
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  say(`done: ${results.length - fails}/${results.length} PASS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
