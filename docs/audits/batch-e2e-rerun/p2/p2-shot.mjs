// WA-BATCH-E2E-RERUN P2: real-UI screenshots (playwright-core + product session cookie).
// Usage: node p2-shot.mjs <out.png> <hash-route> [action: none|click-row]
// Token is read from logs/ui-surfacy/.token at runtime — never embedded.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/usr/lib/node_modules/openclaw/');
const { chromium } = require('playwright-core');

const OUT = process.argv[2];
const ROUTE = process.argv[3] ?? '#/interventions';
const ACTION = process.argv[4] ?? 'none';
const TOKEN = readFileSync('/home/kenneth/.openclaw/workspace/water_army/logs/ui-surfacy/.token', 'utf8').trim();

const browser = await chromium.launch({
  executablePath: '/home/kenneth/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'session', value: TOKEN, domain: '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
page.on('dialog', async (d) => { try { await d.dismiss(); } catch {} });
await page.goto('http://127.0.0.1:3012/' + ROUTE, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3500);
if (ACTION === 'click-row') {
  const btn = page.locator('.att-row .att-title').first();
  await btn.waitFor({ timeout: 15000 }).catch(() => {});
  await btn.click().catch(() => {});
  await page.waitForTimeout(2500);
}
await page.screenshot({ path: OUT });
console.log('screenshot: ' + OUT);
await browser.close();
