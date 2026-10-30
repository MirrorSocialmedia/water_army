// WA-D4 v2: generic IME-wake fill. Usage: node d4v2-fill.cjs <base> <selector> <text> [lastChar]
const base = process.argv[2];
const sel = process.argv[3];
const text = process.argv[4];
const last = process.argv[5] || text[text.length - 1];
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
  const ok = await evalJs(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NO_EL'; el.focus(); return 'FOCUSED'; })()`);
  if (ok !== 'FOCUSED') { console.log('FILL_FAIL', ok); ws.close(); return; }
  await send('Input.insertText', { text });
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await send('Input.insertText', { text: last });
  const state = await evalJs(`(() => { const el=document.activeElement; if(!el||!el.value) return 'ACTIVE_EMPTY:'+(el&&el.tagName); return JSON.stringify({tag:el.tagName,type:el.type,len:el.value.length,rect:(r=>({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}))(el.getBoundingClientRect())}); })()`);
  console.log('FILLED', state);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
