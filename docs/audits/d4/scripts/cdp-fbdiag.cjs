// D4: POST once, report embedded error markers from response HTML.
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
  const evalJs = async (expr, awaitP) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitP });
    if (r.exceptionDetails) throw new Error('EX: ' + JSON.stringify(r.exceptionDetails.exception).slice(0, 200));
    return r.result && r.result.value;
  };
  const tok = await evalJs(`(() => { const u = new URL(performance.getEntriesByType('resource').map(r=>r.name).find(n=>/wbloks\\/log/.test(n))||location.href); return JSON.stringify({lsd:u.searchParams.get('lsd')||'', jz:u.searchParams.get('jazoest')||'', u:location.href}); })()`);
  let { lsd, jz } = JSON.parse(tok);
  if (!lsd) {
    const h = await evalJs(`(() => { const m=document.documentElement.innerHTML.match(/lsd[\"':= ]+([A-Za-z0-9_\\-]{18,28})/); const j=document.documentElement.innerHTML.match(/jazoest[=\"']?(2\\d{4})/); return JSON.stringify({lsd:m?m[1]:'',jz:j?j[1]:''}); })()`);
    ({ lsd, jz } = JSON.parse(h));
  }
  console.log('tok:', lsd ? 'ok' : 'MISSING', jz);
  const expr = `(async () => {
    const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(), 20000);
    try {
      const body = new URLSearchParams({ lsd: ${JSON.stringify('' + lsd)}, jazoest: ${JSON.stringify('' + jz)}, email: ${JSON.stringify(email)}, pass: ${JSON.stringify(pw)}, login_attempt: '1' });
      const r = await fetch('/login/device-based/regular/login/', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString(), signal: ctl.signal });
      clearTimeout(timer);
      const t = await r.text();
      const markers = [];
      for (const re of [/wrong_password/gi, /bad_password/gi, /invalid_password/gi, /unrecognized/gi, /account_not_found/gi, /checkpoint/gi, /captcha/gi, /Try again/gi, /Invalid/i, /not.{0,10}on Facebook/i, /login_failed/gi, /ct_|c_user/]) {
        const m = t.match(re); if (m) markers.push(re.source + ':' + (m.index !== undefined ? m.index : '?'));
      }
      const bls = t.match(/"bl".../);
      const errBlobs = (t.match(/"error[^\"]*"\s*:\s*"[^"]{0,80}"/g) || []).slice(0,5);
      const title = (t.match(/<title>([^<]*)/) || [])[1];
      const doc = new DOMParser().parseFromString(t, 'text/html');
      const clone = doc.body ? doc.body.cloneNode(true) : null;
      if (clone) { clone.querySelectorAll('script,style,noscript').forEach(n => n.remove()); }
      const visible = (clone ? clone.textContent : '').replace(/\s+/g, ' ').trim();
      return JSON.stringify({ status:r.status, finalUrl:r.url, len:t.length, markers: markers.slice(0,12), errBlobs, title, visLen: visible.length, visible: visible.slice(0, 260) });
    } catch (e) { clearTimeout(timer); return 'FETCH_' + e.name; }
  })()`;
  const out = await evalJs(expr, true);
  console.log('DIAG:', out);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
