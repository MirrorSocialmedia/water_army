// D4: FB React login via fully trusted CDP input path.
// Usage: node cdp-fblogin.cjs <cdpBase> <email>   (password from env ADV_PW)
const base = process.argv[2] || 'http://127.0.0.1:9322';
const email = process.argv[3];
const pw = process.env.ADV_PW;
if (!email || !pw) { console.error('MISSING_EMAIL_OR_PW'); process.exit(2); }

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
    return r.result && r.result.value;
  };
  await send('Page.enable');
  // 1. focused insertText into email + password (trusted input events)
  const e1 = await evalJs(`(() => { const el=document.querySelector('input[name="email"]'); if(!el) return 'NO_EM'; const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value'); d.set.call(el,''); el.focus(); return 'EM_FOCUSED'; })()`);
  if (e1 !== 'EM_FOCUSED') throw new Error('email focus failed: ' + e1);
  await send('Input.insertText', { text: email });
  const e2 = await evalJs(`(() => { const el=document.querySelector('input[name="pass"]'); if(!el) return 'NO_PW'; const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value'); d.set.call(el,''); el.focus(); return 'PW_FOCUSED'; })()`);
  if (e2 !== 'PW_FOCUSED') throw new Error('password focus failed: ' + e2);
  await send('Input.insertText', { text: pw });
  const lens = await evalJs(`JSON.stringify({em: document.querySelector('input[name="email"]').value.length, pw: document.querySelector('input[name="pass"]').value.length})`);
  // 2. trusted click on "Log in"
  const box = await evalJs(`(() => { const b=Array.from(document.querySelectorAll('[role="button"],button')).find(x=>(x.textContent||'').trim()==='Log in'); if(!b) return null; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`);
  if (!box) throw new Error('no Log in button');
  const { x, y } = JSON.parse(box);
  try {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } catch (e) { console.log('touch-skip:', e.message); }
  // Enter key on focused password (React submits on Enter)
  await evalJs(`(() => { const el=document.querySelector('input[name="pass"]'); if(el) el.focus(); return 'FOC'; })()`);
  const key = (type, extra) => send('Input.dispatchKeyEvent', Object.assign({ type }, extra || {}));
  await key('rawKeyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await key('char', { text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  // 3. poll URL
  for (let i = 0; i < 7; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const url = await evalJs('location.href').catch(() => 'eval-failed');
    const body = await evalJs('document.body.innerText.replace(/\\s+/g," ").slice(0,200)').catch(() => '');
    console.log('t+' + ((i + 1) * 3) + 's', url, '|', (body || '').slice(0, 140));
    if (url && !/login|facebook\.com\/?$/.test(url.replace(/^https:\/\/m\.facebook\.com\/?/, 'FBLAND:'))) { console.log('NAVIGATED'); break; }
    const stillLogin = await evalJs('!!document.querySelector(\'input[name="pass"]\')').catch(() => true);
    if (!stillLogin) { console.log('LOGIN_FORM_GONE'); break; }
  }
  console.log('lens at submit:', lens);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
