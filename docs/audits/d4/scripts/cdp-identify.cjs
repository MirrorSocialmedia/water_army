// D4: FB account-existence lookup via /login/identify (fetch in-page, visible text of response).
const base = process.argv[2] || 'http://127.0.0.1:9322';
const email = process.argv[3];
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
  const expr = `(async () => {
    const html = document.documentElement.innerHTML;
    const m = html.match(/lsd["':= ]+([A-Za-z0-9_\\-]{18,28})/);
    const j = html.match(/jazoest[="']?(2\\d{4})/);
    if (!m) return 'NO_LSD';
    const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(), 20000);
    try {
      const body = new URLSearchParams({ lsd: m[1], jazoest: j ? j[1] : '', email: ${JSON.stringify(email)}, console: 'true', referral: 'aggregation_unit::NuxLink' });
      const r = await fetch('/login/identify/', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString(), signal: ctl.signal });
      clearTimeout(timer);
      const t = await r.text();
      const doc = new DOMParser().parseFromString(t, 'text/html');
      const clone = doc.body ? doc.body.cloneNode(true) : null;
      if (clone) { clone.querySelectorAll('script,style,noscript').forEach(n => n.remove()); }
      const visible = (clone ? clone.textContent : '').replace(/\\s+/g,' ').trim();
      const markers = [];
      for (const re of [/Grace/, /Cheung/, /corresponding/i, /hollowotter/, /Check your spelling/i, /account you have/i]) {
        const mm = t.match(re); if (mm) markers.push(re.source + '@' + mm.index);
      }
      return JSON.stringify({ status: r.status, len: t.length, title: (t.match(/<title>([^<]*)/)||[])[1], markers, visible: visible.slice(0, 300) });
    } catch (e) { clearTimeout(timer); return 'FETCH_' + e.name; }
  })()`;
  const out = await evalJs(expr, true);
  console.log('IDENTIFY:', out);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
