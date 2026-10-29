// D4: Bloks login POST v2 — fresh reload + abort timeout.
// Usage: node cdp-fbpost2.cjs <cdpBase> <email>   (pw in env ADV_PW)
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
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 30000);
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    }
  };
  const evalJs = async (expr, awaitP, ms) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitP });
    if (r.exceptionDetails) throw new Error('EX: ' + JSON.stringify(r.exceptionDetails.exception).slice(0, 200));
    return r.result && r.result.value;
  };
  await send('Page.enable');
  // fresh scrape of lsd/jazoest from current HTML (not perf cache)
  const tok = await evalJs(`(() => {
    const m = document.documentElement.innerHTML.match(/[\"']lsd[\"']?[\\s:=\"']+([A-Za-z0-9_\\-]{15,30})/);
    const j = document.documentElement.innerHTML.match(/jazoest=(2\\d{4})/);
    return JSON.stringify({lsd: m ? m[1] : '', jz: j ? j[1] : ''});
  })()`);
  console.log('tokens2:', tok);
  let { lsd, jz } = JSON.parse(tok);
  if (!lsd) {
    const res = await evalJs(`(() => { const n = performance.getEntriesByType('resource').map(r=>r.name).find(n=>/wbloks\\/log/.test(n)); if(!n) return null; const u=new URL(n); return JSON.stringify({lsd:u.searchParams.get('lsd'), jz:u.searchParams.get('jazoest')}); })()`);
    ({ lsd, jz } = JSON.parse(res));
    console.log('tokens3 (perf):', res);
  }
  if (!lsd) throw new Error('no lsd');
  const expr = `(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
    try {
      const body = new URLSearchParams({ lsd: ${JSON.stringify(lsd)}, jazoest: ${JSON.stringify(jz)}, email: ${JSON.stringify(email)}, pass: ${JSON.stringify(pw)}, login_attempt: '1' });
      const r = await fetch('/login/device-based/regular/login/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: ctl.signal });
      clearTimeout(timer);
      const t = await r.text();
      const doc = new DOMParser().parseFromString(t, 'text/html');
      const err = doc.querySelector('#login_error, [role="alert"], .login_error');
      const title2 = doc.querySelector('title') ? doc.querySelector('title').textContent : '';
      return JSON.stringify({ status: r.status, finalUrl: r.url, len: t.length, errText: err ? err.textContent.replace(/\s+/g,' ').trim().slice(0,120) : '', title: title2 });
    } catch (e) { clearTimeout(timer); return 'FETCH_' + (e.name === 'AbortError' ? 'ABORT45s' : 'ERR:' + e.message); }
  })()`;
  const out = await evalJs(expr, true);
  console.log('POST2:', out);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
