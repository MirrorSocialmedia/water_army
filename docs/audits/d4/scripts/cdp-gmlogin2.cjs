// D4-GM A路: Google sign-in step. mode=email|password; value from env GVAL (never logged).
const base = process.argv[2] || 'http://127.0.0.1:9323';
const mode = process.argv[3]; // email | password
const val = process.env.GVAL || '';
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
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 20000);
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
    if (r.exceptionDetails) throw new Error('EX: ' + JSON.stringify(r.exceptionDetails.exception).slice(0,200));
    return r.result && r.result.value;
  };
  const sel = mode === 'password' ? 'input[type="password"], input[name="Passwd"], input[aria-label*="password" i]' : 'input[type="email"], input[name="identifier"], #identifierId';
  const filled = await evalJs(`(() => {
    const em = document.querySelector(${JSON.stringify(sel)});
    if (!em) return 'NO_INPUT';
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(em), 'value');
    d.set.call(em, ${JSON.stringify(val)});
    em.dispatchEvent(new Event('input', { bubbles: true }));
    em.dispatchEvent(new Event('change', { bubbles: true }));
    em.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', keyCode: 13 }));
    return 'FILLED';
  })()`);
  console.log(mode + ':', filled, 'len=' + val.length);
  const clicked = await evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button,[role="button"]')).find(x => /^(next|sign in)$/i.test((x.textContent||'').trim()) || (x.getAttribute('aria-label')||'') === 'Next');
    if (!b) return 'NO_BTN';
    b.click();
    return 'CLICKED';
  })()`);
  console.log('btn:', clicked);
  await new Promise(r => setTimeout(r, 8000));
  const after = await evalJs(`JSON.stringify({url: location.href.slice(0,110), title: document.title.slice(0,50)})`);
  console.log('after:', after);
  const errTxt = await evalJs(`(() => { const e = document.querySelector('[role="alert"], .hfstrb, [jsname="MNvT2b"], [jsname="bQDrKe"]'); return e ? (e.textContent||'').trim().slice(0,120) : 'NO_ERR'; })()`);
  console.log('err:', errTxt);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
