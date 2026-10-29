// D4-GM: fill Google identifier + click Next (synthetic ok for Google).
const base = process.argv[2] || 'http://127.0.0.1:9323';
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
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 15000);
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
  const filled = await evalJs(`(() => {
    const em = document.querySelector('input[type="email"], input[name="identifier"], #identifierId');
    if (!em) return 'NO_EM';
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(em), 'value');
    d.set.call(em, ${JSON.stringify(email)});
    em.dispatchEvent(new Event('input', { bubbles: true }));
    em.dispatchEvent(new Event('change', { bubbles: true }));
    em.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', keyCode: 13 }));
    return 'FILLED:' + em.value.length;
  })()`);
  console.log('email:', filled);
  const clicked = await evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button,[role="button"]')).find(x => /^next$/i.test((x.textContent||'').trim()) || (x.getAttribute('aria-label')||'') === 'Next');
    if (!b) return 'NO_NEXT';
    b.click();
    return 'CLICKED:' + b.tagName;
  })()`);
  console.log('next:', clicked);
  await new Promise(r => setTimeout(r, 6000));
  const after = await evalJs(`JSON.stringify({url: location.href.slice(0,90), title: document.title.slice(0,40)})`);
  console.log('after:', after);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
