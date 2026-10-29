// D4: top-level legacy form POST login (fire & forget, page navigates).
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
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 12000);
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    }
  };
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.value;
  };
  const expr = `(() => {
    const html = document.documentElement.innerHTML;
    const m = html.match(/lsd[\"':= ]+([A-Za-z0-9_\\-]{18,28})/);
    const j = html.match(/jazoest[=\"']?(2\\d{4})/);
    if (!m) return 'NO_LSD_IN_HTML';
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = 'https://m.facebook.com/login/device-based/regular/login/';
    f.style.display = 'none';
    const add = (n, v) => { const i = document.createElement('input'); i.name = n; i.value = v; f.appendChild(i); };
    add('lsd', m[1]);
    add('jazoest', j ? j[1] : '');
    add('email', ${JSON.stringify(email)});
    add('pass', ${JSON.stringify(pw)});
    add('login_attempt', '1');
    document.body.appendChild(f);
    setTimeout(() => f.submit(), 50);
    return 'SUBMITTING lsd=' + m[1].slice(0, 6) + '…';
  })()`;
  const out = await evalJs(expr);
  console.log('form:', out);
  setTimeout(() => { try { ws.close(); } catch (e) {} }, 8000);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
