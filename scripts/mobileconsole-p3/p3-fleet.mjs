/**
 * P3 Fleet Console E2E — final (gen5 closure). MD §14 Phase 3 / §15.3.
 *
 * Scenarios (CEO closure task 2026-10-24):
 *  T30 baseline   — admin opens 1→5 tiles; slot count 0/5 → 5/5; all LIVE
 *  T31 6th-local  — at 5/5 the operator's page locally refuses the 6th stream:
 *                   ALL chips disabled (cap-reached pre-check) + the server
 *                   stays the final arbiter: a direct API acquire → 409 with
 *                   the fixed STREAM_* code
 *  T32 re-acquire — close one tile → 4/5 → re-open the same device → LIVE → 5/5
 *  T33 last-slot  — two users race the last free slot (both click the same
 *                   chip): exactly one 201 + one 409; winner tile LIVE,
 *                   loser tile fixed CAPACITY_REACHED error state (no crash)
 *  T34 close-all  — admin 全關閉 (confirm dialog) → usage 0/5
 *
 * Real devices: redroid-brmc-poc/s2/s3/s4/s5 (5 running, scratch stack).
 * Raw evidence: logs/mobileconsole-p3/fleet-e2e/ (JSON + screenshots).
 * Run: env MC_ADMIN_USER/MC_ADMIN_PASS + MC_OP_USER/MC_OP_PASS node p3-fleet.mjs
 */
import fs from 'node:fs';
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';

const WEB = process.env.MC_WEB ?? 'http://127.0.0.1:16492';
const API = process.env.MC_API ?? 'http://127.0.0.1:16490';
const EVID = process.env.MC_EVID ?? '/home/kenneth/.openclaw/workspace/logs/mobileconsole-p3/fleet-e2e';
const DEVICES = ['redroid-brmc-poc', 'redroid-brmc-s2', 'redroid-brmc-s3', 'redroid-brmc-s4', 'redroid-brmc-s5'];
fs.mkdirSync(EVID, { recursive: true });

const startedAt = new Date().toISOString();
const results = [];
const mark = (t, ok, detail) => {
  results.push({ t, ok, detail });
  console.log(`MARK ${t} ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
};
const say = (m) => console.log(`[fleet-e2e ${new Date().toISOString()}] ${m}`);
const ev = (name, obj) => {
  const p = `${EVID}/${name}`;
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  say(`evidence → ${p}`);
};

async function login(browser, user, pass) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', pass);
  await page.click('button[type="submit"]');
  // loud-fail on login problems (P2 lesson: never sail into tests logged out)
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

async function gotoFleet(page) {
  await page.goto(`${WEB}/#/devices/fleet`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2_000);
}

async function slotCount(page) {
  return page.evaluate(() => {
    const pill = [...document.querySelectorAll('.fleet-usage')].map((e) => e.textContent).join(' ');
    const m = /(\d+)\s*\/\s*(\d+)/.exec(pill);
    return m ? Number(m[1]) : -1;
  });
}

async function waitSlot(page, want, budgetMs = 60_000) {
  const t0 = Date.now();
  let last = -1;
  for (;;) {
    const got = await slotCount(page);
    last = got;
    if (got === want) return true;
    if (Date.now() - t0 > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function chipStates(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.chip')].map((c) => ({
      text: c.textContent.trim(),
      disabled: c.disabled,
      title: c.getAttribute('title') ?? '',
      open: c.classList.contains('chip-open'),
    })),
  );
}

async function openChip(page, name, { expectEnabled = true } = {}) {
  const chip = page.locator('.chip', { hasText: name }).first();
  await chip.waitFor({ state: 'visible', timeout: 15_000 });
  const enabled = await chip.isEnabled();
  if (expectEnabled && !enabled) throw new Error(`chip ${name} unexpectedly disabled (title=${await chip.getAttribute('title')})`);
  if (enabled) await chip.click({ timeout: 10_000 });
  return enabled;
}

async function closeTile(page, idx) {
  const btn = page.locator('.fleet-tile').nth(idx).locator('button.fleet-close');
  if (await btn.count() > 0) await btn.click({ timeout: 10_000 }).catch(() => {});
}

/** DOM-order chip click for the 2-user race (bypasses Playwright's
 *  actionability waits on purpose — we want the raw simultaneous click). */
async function rawClickChip(page, name) {
  return page.evaluate((nm) => {
    const chip = [...document.querySelectorAll('.chip')].find((c) => c.textContent.includes(nm));
    if (!chip) return 'no-chip';
    if (chip.disabled) return 'disabled';
    chip.click();
    return 'clicked';
  }, name);
}

async function tileStates(page, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(await page.evaluate((idx) => {
      const t = document.querySelectorAll('.fleet-tile')[idx];
      if (!t) return null;
      return {
        name: t.querySelector('h3')?.textContent ?? null,
        state: ((t.className.match(/stream-([a-z_]+)/) ?? [])[1] ?? '?').toUpperCase(),
        errorBox: t.querySelector('.error-box')?.textContent ?? null,
      };
    }, i));
  }
  return out;
}

/** Locate ONE tile by device name (DOM order = openIds order — the race tile
 *  is NOT always index 0; the winner's page may already hold 4 other tiles). */
async function tileByName(page, name) {
  return page.evaluate((nm) => {
    const ts = [...document.querySelectorAll('.fleet-tile')];
    const i = ts.findIndex((x) => x.querySelector('h3')?.textContent === nm);
    if (i < 0) return null;
    const t = ts[i];
    return {
      idx: i,
      name: t.querySelector('h3')?.textContent ?? null,
      state: ((t.className.match(/stream-([a-z_]+)/) ?? [])[1] ?? '?').toUpperCase(),
      errorBox: t.querySelector('.error-box')?.textContent ?? null,
    };
  }, name);
}

async function closeTileByName(page, name) {
  const t = await tileByName(page, name);
  if (!t) return false;
  await page.locator('.fleet-tile').nth(t.idx).locator('button.fleet-close').click({ timeout: 10_000 }).catch(() => {});
  return true;
}

async function waitAllLive(page, n, budgetMs = 120_000) {
  const t0 = Date.now();
  let st = [];
  for (;;) {
    st = await tileStates(page, n);
    if (st.every((s) => s && s.state.startsWith('LIVE'))) return st;
    if (Date.now() - t0 > budgetMs) return st;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

(async () => {
  say('start');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // Track every POST /streams that the pages make (UI-level HTTP truth).
  const httpSeen = [];
  const ctxWho = new Map();
  const watch = (ctx, who) => {
    ctxWho.set(ctx, who);
    ctx.on('response', async (r) => {
      try {
        const u = r.url();
        if (r.request().method() !== 'POST' || !/\/api\/devices\/redroid\/[^/]+\/streams$/.test(u)) return;
        let code = null;
        let message = null;
        try {
          const b = await r.json();
          code = b.code ?? null;
          message = b.message ?? null;
        } catch { /* non-JSON — keep status only */ }
        httpSeen.push({ who, status: r.status(), code, message, at: new Date().toISOString() });
      } catch { /* listener must never throw */ }
    });
  };

  // ---------------- operators ---------------------------------------------------
  const A = await login(browser, process.env.MC_ADMIN_USER, process.env.MC_ADMIN_PASS);
  watch(A.ctx, 'admin');
  await gotoFleet(A.page);
  const O = await login(browser, process.env.MC_OP_USER, process.env.MC_OP_PASS);
  watch(O.ctx, 'operator');
  await gotoFleet(O.page);

  const devList = await A.ctx.request.get(`${API}/api/devices/redroid`).then((r) => r.json());
  const devId = Object.fromEntries(devList.devices.map((d) => [d.name, d.id]));
  const RACE_DEV = DEVICES[DEVICES.length - 1]; // redroid-brmc-s5

  // ---------------- T30: open 1→5, slot count follows, all LIVE ----------------
  const s0ok = await waitSlot(A.page, 0, 20_000);
  const s0 = await slotCount(A.page);
  for (const name of DEVICES) {
    await openChip(A.page, name);
    say(`tile opened: ${name}`);
    // Test pacing (NOT a product change): the one-shot stream_ticket cookie is a
    // SINGLE browser cookie slot (MD §11.8) — each acquire's Set-Cookie
    // overwrites the jar, and a tile's WS upgrade must go out while ITS ticket
    // is still the newest. A 400ms gap makes the acquire/upgrade ordering
    // deterministic (the ladder's back-to-back opens win this lottery by
    // timing only; see P3 report "known limitations — cookie slot").
    await A.page.waitForTimeout(400);
  }
  const liveAll = await waitAllLive(A.page, 5);
  const s5 = (await waitSlot(A.page, 5, 30_000)) ? await slotCount(A.page) : -1;
  await A.page.screenshot({ path: `${EVID}/t30-all-live.png` }).catch(() => {});
  mark('T30', s0ok && s0 === 0 && liveAll.every((s) => s && s.state.startsWith('LIVE')) && s5 === 5,
    `open 1→5: start=${s0}/5, all LIVE=${liveAll.every((s) => s?.state?.startsWith('LIVE'))}, end=${s5}/5 (MD §14 P3 layout 1–5 + slot count)`);

  // ---------------- T31: 6th stream — local chip refusal + server 409 ----------
  // Admin holds all 5 slots. On the OPERATOR's page the 6th (their first)
  // stream must be refused LOCALLY (every chip disabled — cap-reached
  // pre-check) and the SERVER stays the final arbiter (409, fixed code).
  const opCapOk = await waitSlot(O.page, 5, 30_000);
  const opChips = await chipStates(O.page);
  const allDisabled = opChips.length === 5 && opChips.every((c) => c.disabled && /5\s*\/\s*5/.test(c.title));
  await O.page.screenshot({ path: `${EVID}/t31-op-chips-disabled.png` }).catch(() => {});
  // server final arbiter: operator's own session, direct API acquire (s5)
  const r6 = await O.ctx.request.post(`${API}/api/devices/redroid/${devId[RACE_DEV]}/streams`, { data: { mode: 'controller' } });
  const r6body = await r6.json().catch(() => ({}));
  ev('t31-6th-refusal.json', {
    scenario: '6th stream refused',
    at: new Date().toISOString(),
    usage: '5/5 (admin holds all 5 tiles)',
    operatorPage: { usagePillReached55: opCapOk, chips: opChips, allChipsDisabledCapReached: allDisabled },
    serverArbiter: { httpStatus: r6.status(), code: r6body.code ?? null, message: r6body.message ?? null },
  });
  mark('T31', opCapOk && allDisabled && r6.status() === 409 && typeof r6body.code === 'string' && r6body.code.startsWith('STREAM_'),
    `6th stream: operator chips all disabled at 5/5 (${opChips.filter((c) => c.disabled).length}/5, cap-reached pre-check) + server 409 ${r6body.code ?? '?'} — fixed code, 終極裁判 (MD §14 P3 第6格安全拒绝)`);

  // ---------------- T32: close one → 4/5 → re-acquire → LIVE -------------------
  const closeIdx = DEVICES.length - 1; // s5
  await closeTile(A.page, closeIdx);
  const freed = await waitSlot(A.page, 4, 45_000);
  const reOpened = await openChip(A.page, RACE_DEV).catch((e) => { say(`T32 reopen failed: ${e.message}`); return false; });
  const st2 = await waitAllLive(A.page, 5, 90_000);
  const back = await waitSlot(A.page, 5, 30_000);
  await A.page.screenshot({ path: `${EVID}/t32-reacquire-live.png` }).catch(() => {});
  mark('T32', freed && reOpened && st2.every((s) => s?.state?.startsWith('LIVE')) && back,
    `close→4/5=${freed}, re-acquire same device→LIVE=${st2.every((s) => s?.state?.startsWith('LIVE'))}, back to 5/5=${back} (MD §15.3 關掉一格 slot 可重取)`);

  // ---------------- T33: two users race the last slot ---------------------------
  // Admin closes s5 → 4/5 (one free slot). BOTH users then click the s5 chip
  // at the same instant: exactly one acquire is 201, the other 409.
  await closeTile(A.page, closeIdx);
  const down4 = await waitSlot(A.page, 4, 45_000);
  const opDown4 = await waitSlot(O.page, 4, 30_000);
  const seenBefore = httpSeen.length;
  const [ra, ro] = await Promise.all([rawClickChip(A.page, RACE_DEV), rawClickChip(O.page, RACE_DEV)]);
  say(`race clicks: admin=${ra} operator=${ro}`);
  const raceT0 = Date.now();
  let race = [];
  for (;;) {
    race = httpSeen.slice(seenBefore);
    if (race.length >= 2 || Date.now() - raceT0 > 20_000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const codes = race.map((x) => x.status).sort((x, y) => x - y);
  const winner = (race.find((x) => x.status === 201) ?? {}).who ?? 'unknown';
  const loser = winner === 'admin' ? 'operator' : 'admin';
  const winnerPage = winner === 'admin' ? A : O;
  const loserPage = winner === 'admin' ? O : A;
  // winner tile → LIVE; loser tile → fixed CAPACITY_REACHED error state
  // (locate by device name — the race tile is the LAST tile on a page that
  //  already holds 4 others, and the first one on the other page)
  const winnerSt = await (async () => {
    const t0 = Date.now();
    let st = null;
    for (;;) {
      st = await tileByName(winnerPage.page, RACE_DEV);
      if (st && st.state === 'LIVE_CONTROLLED_BY_YOU') return st;
      if (Date.now() - t0 > 90_000) return st;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  })();
  const loserSt = await (async () => {
    const t0 = Date.now();
    let st = null;
    for (;;) {
      st = await tileByName(loserPage.page, RACE_DEV);
      if (st && !st.state.startsWith('LIVE') && st.state !== 'CONNECTING') return st;
      if (Date.now() - t0 > 20_000) return st;
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  const usageAtRace = await slotCount(A.page); // 5/5 while the race lease lives
  await winnerPage.page.screenshot({ path: `${EVID}/t33-winner-${winner}.png` }).catch(() => {});
  await loserPage.page.screenshot({ path: `${EVID}/t33-loser-${loser}.png` }).catch(() => {});
  ev('t33-last-slot-race.json', {
    scenario: 'two users race the last slot',
    at: new Date().toISOString(),
    usageBefore: '4/5 (admin closed s5)',
    clicks: { admin: ra, operator: ro },
    http: race,
    winner,
    loser,
    winnerUi: winnerSt ?? null,
    loserUi: loserSt ?? null,
    usageAfterRace: usageAtRace,
  });
  const t33ok =
    down4 && opDown4 && ra === 'clicked' && ro === 'clicked' &&
    codes.length === 2 && codes[0] === 201 && codes[1] === 409 &&
    winnerSt?.state === 'LIVE_CONTROLLED_BY_YOU' &&
    loserSt && loserSt.state === 'CAPACITY_REACHED' && Boolean(loserSt.errorBox);
  mark('T33', t33ok,
    `race last slot: HTTP ${codes.join('/')} (exactly one 201 + one 409 — MD §15.3 兩用戶搶末格), winner=${winner} LIVE=${winnerSt?.state}, loser=${loser} state=${loserSt?.state} errorBox=${JSON.stringify(loserSt?.errorBox ?? null)}`);
  // close BOTH raced tiles (winner's real lease + loser's error tile) → 4/5
  await closeTileByName(winnerPage.page, RACE_DEV);
  await closeTileByName(loserPage.page, RACE_DEV);
  const raceCleaned = await waitSlot(A.page, 4, 45_000);
  say(`T33 cleanup: both raced tiles closed, back to 4/5=${raceCleaned}`);

  // ---------------- T34: close-all (confirm) → 0/5 ------------------------------
  A.page.once('dialog', (d) => d.accept());
  await A.page.locator('button:has-text("全關閉")').click();
  const zero = await waitSlot(A.page, 0, 60_000);
  const tilesLeft = await A.page.evaluate(() => document.querySelectorAll('.fleet-tile').length);
  await A.page.screenshot({ path: `${EVID}/t34-zero.png` }).catch(() => {});
  ev('t34-close-all.json', {
    scenario: 'close-all via confirm dialog',
    at: new Date().toISOString(),
    usage: zero >= 0 ? `0/${5}` : 'unreadable',
    tilesLeft,
  });
  mark('T34', zero && tilesLeft === 0, `close-all (confirm) → slots ${zero}/5, tiles left=${tilesLeft} (MD §14 P3 全關閉)`);

  // ---------------- teardown -----------------------------------------------------
  ev('p3-fleet-summary.json', {
    startedAt,
    finishedAt: new Date().toISOString(),
    web: WEB,
    devices: DEVICES,
    results,
    httpSeenCount: httpSeen.length,
  });
  await A.ctx.close().catch(() => {});
  await O.ctx.close().catch(() => {});
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  say(`done: ${results.length - fails}/${results.length} PASS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
