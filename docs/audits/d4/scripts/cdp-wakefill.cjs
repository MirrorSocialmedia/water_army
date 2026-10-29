// D4: wake-Bloks fill: insertText + trusted Backspace + re-add last char per field.
// Usage: node cdp-wakefill.cjs <base> <email> <lastCharEmail>   env: ADV_PW, LASTPW
const base = process.argv[2] || 'http://127.0.0.1:9322';
const email = process.argv[3];
const lastEM = process.argv[4] || 'm';
const pw = process.env.ADV_PW;
const lastPW = process.env.LASTPW;
async function main() {
  if (!email || !pw || !lastPW) { console.error('MISSING_ARGS'); process.exit(2); }
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
  const backspace = async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  };
  // email
  await evalJs(`(() => { const el=document.querySelector('input[name="email"]'); const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value'); d.set.call(el,''); el.focus(); return 'F'; })()`);
  await send('Input.insertText', { text: email });
  await backspace();
  await send('Input.insertText', { text: lastEM });
  // password
  await evalJs(`(() => { const el=document.querySelector('input[name="pass"]'); const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value'); d.set.call(el,''); el.focus(); return 'F'; })()`);
  await send('Input.insertText', { text: pw });
  await backspace();
  await send('Input.insertText', { text: lastPW });
  const lens = await evalJs(`JSON.stringify({em: document.querySelector('input[name="email"]').value.length, pw: document.querySelector('input[name="pass"]').value.length})`);
  const box = await evalJs(`(() => { const b=Array.from(document.querySelectorAll('[role="button"]')).find(x=>(x.getAttribute('aria-label')||'')==='Log in'); const r=b.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`);
  const { x, y } = JSON.parse(box);
  const dev = { dx: Math.round(x * 2.625), dy: Math.round(56 + y * 2.625) };
  console.log('lens:', lens, 'button css:', box, 'device:', JSON.stringify(dev));
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
