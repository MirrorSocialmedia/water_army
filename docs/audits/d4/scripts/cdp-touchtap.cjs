// D4: Bloks login submit via enabled touch emulation + touchstart/touchend.
const base = process.argv[2] || 'http://127.0.0.1:9322';
async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 8000);
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
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const box = await evalJs(`(() => { const b=Array.from(document.querySelectorAll('[role="button"]')).find(x=>(x.getAttribute('aria-label')||'')==='Log in'); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`);
  if (!box) throw new Error('no Log in button');
  const { x, y } = JSON.parse(box);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await new Promise(r => setTimeout(r, 120));
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x, y, id: 1 }] });
  console.log('TOUCH_TAPPED at', Math.round(x) + ',' + Math.round(y));
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const url = await evalJs('location.href').catch(() => 'eval-failed');
    const body = await evalJs('document.body.innerText.replace(/\\s+/g," ").slice(0,180)').catch(() => '');
    console.log('t+' + ((i + 1) * 3) + 's', url, '|', (body || '').slice(0, 160));
  }
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
