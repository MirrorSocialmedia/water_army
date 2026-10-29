// D4: Bloks login POST from page context (same-origin, real cookies).
// Usage: node cdp-fbpost.cjs <cdpBase> <email>   (pw in env ADV_PW)
const base = process.argv[2] || 'http://127.0.0.1:9322';
const email = process.argv[3];
const pw = process.env.ADV_PW;
async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 60000);
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    }
  };
  const evalJs = async (expr, awaitP) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitP });
    if (r.exceptionDetails) throw new Error('EX: ' + JSON.stringify(r.exceptionDetails.exception).slice(0, 200));
    return r.result && r.result.value;
  };
  // scrape lsd/jazoest from page resources
  const tok = await evalJs(`(() => {
    const res = performance.getEntriesByType('resource').map(r=>r.name).find(n=>/wbloks\\/log/.test(n)) || '';
    const lsd = (new URL(res).searchParams.get('lsd')) || (window.lsd && window.lsd.token) || '';
    const jz = new URL(res).searchParams.get('jazoest') || '';
    return JSON.stringify({lsd, jz, imp: new URL(res).searchParams.get('impid')});
  })()`);
  console.log('tokens:', tok);
  const { lsd, jz } = JSON.parse(tok);
  if (!lsd) throw new Error('no lsd token');
  const expr = `(async () => {
    const body = new URLSearchParams({ lsd: ${JSON.stringify(lsd)}, jazoest: ${JSON.stringify(jz)}, email: ${JSON.stringify(email)}, pass: ${JSON.stringify(pw)}, login_attempt: '1', async: '' });
    try {
      const r = await fetch('/login/device-based/regular/login/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const t = await r.text();
      return JSON.stringify({ status: r.status, finalUrl: r.url, len: t.length, hint: (t.match(/(checkpoint|invalid|password|ct_|login_|home|feed)[^\"<>&]{0,30}/i)||['no-hit'])[0].slice(0,60) });
    } catch (e) { return 'FETCH_ERR:' + e.message; }
  })()`;
  const out = await evalJs(expr, true);
  console.log('POST result:', out);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
