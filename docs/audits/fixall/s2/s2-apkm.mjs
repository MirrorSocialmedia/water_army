#!/usr/bin/env node
/**
 * WA-FIXALL S2 — APKMirror fetch helper (host, headless chromium passes CF JS challenge).
 * Usage: node s2-apkm.mjs <URL> [rowFilterRegex]
 * Prints JSON: {title, url, rows:[{href,text}]} — one row per anchor whose
 * closest table row (or anchor text) matches rowFilterRegex (default: any link
 * to a .zip/.apkm/variation/download page).
 */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('/usr/lib/node_modules/openclaw/node_modules/playwright-core');
const EXE = '/home/kenneth/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';

(async () => {
  const [url, rowFilter] = [process.argv[2], process.argv[3]];
  if (!url) { console.error('usage: s2-apkm.mjs <URL> [rowFilterRegex]'); process.exit(2); }
  const re = rowFilter ? new RegExp(rowFilter, 'i') : /(variation|download|\.zip|\.apkm)/i;
  const browser = await chromium.launch({ executablePath: EXE, headless: true, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-gpu', '--disable-blink-features=AutomationControlled', '--no-first-run'] });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {} });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    // CF JS challenge: poll until title settles (not 'Just a moment'/'Redirecting' left dangling)
    for (let i = 0; i < 40; i++) {
      const t = await page.title().catch(() => '');
      if (!/just a moment/i.test(t) && t) break;
      // interactive Turnstile: try clicking the checkbox inside challenge iframe(s)
      if (i === 12 || i === 24) {
        for (const fr of page.frames()) {
          try { const box = await fr.$('input[type=checkbox], .cb-turnstile-sentence, #turnstile-wrapper'); if (box) await box.click({ timeout: 2000 }).catch(() => {}); } catch (e) {}
        }
      }
      await page.waitForTimeout(2000);
    }
    const finalTitle = await page.title().catch(() => '');
    if (/just a moment/i.test(finalTitle)) { await page.screenshot({ path: '/tmp/apkm-challenge.png' }).catch(() => {}); }
    await page.waitForTimeout(1500);
    const rows = await page.$$eval('a', (as, pat) => {
      const re = new RegExp(pat, 'i');
      const out = [];
      for (const a of as) {
        const tr = a.closest('tr');
        const hay = (tr ? tr.innerText : '') + ' ' + (a.innerText || '');
        if (re.test(hay)) {
          const href = a.href;
          const text = (tr ? tr.innerText.replace(/\s+/g, ' ').trim() : (a.innerText || '').trim()).slice(0, 300);
          if (/^https?:/.test(href)) out.push({ href, text });
        }
      }
      // dedupe by href
      const seen = new Set();
      return out.filter((r) => !seen.has(r.href) && seen.add(r.href));
    }, rowFilter || '(variation|download|\\.zip|\\.apkm)');
    console.log(JSON.stringify({ title: finalTitle, url: page.url(), rows }, null, 1));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
