// WA-D4 gen5 registration helper. Usage: node d4reg.cjs <sub> <cdpHttpBase> [args]
//   nav  <base> <url>              Page.navigate (tolerate ack timeout; R11)
//   url  <base>                    print URL + visible text digest (buttons/inputs)
//   ev   <base> <jsFile|jsString>  Runtime.evaluate returnByValue
//   fill <base> <selector> <text>  JS focus + IME insertText + wake (d4v2 pattern)
//   snap <base> <out.mhtml>        Page.captureSnapshot
//   shot <base> <out.png>          captureScreenshot (5s) fallback snapshot->render
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = process.env.CHROME_BIN || (require('os').homedir() + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const sub = process.argv[2];
const base = process.argv[3];

async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const filt = process.env.WA_PAGE;
  const page = (filt ? pages.find((t) => t.url.includes(filt)) : null) || pages[0];
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let id = 0; const pend = new Map();
  const send = (m, p, tmo = 10000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP timeout ' + m)); } }, tmo);
  });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 300))) : res(m.result); } };
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.value; };

  if (sub === 'nav') {
    try { await send('Page.navigate', { url: process.argv[4] }, 8000); } catch (e) { console.log('NAV_ACK_TIMEOUT(ignored)'); }
  } else if (sub === 'url') {
    const info = await ev(`(() => {
      const btns=[...document.querySelectorAll('button,[role=button],input[type=submit],a')].map(e=>({t:(e.innerText||e.value||'').trim().slice(0,30),r:(x=>({x:Math.round(x.left+x.width/2),y:Math.round(x.top+x.height/2)}))(e.getBoundingClientRect())})).filter(x=>x.t);
      const ins=[...document.querySelectorAll('input,select')].map(e=>({n:e.name||e.id||e.getAttribute('aria-label')||e.tagName,t:e.type||e.tagName,v:(e.value||'').slice(0,25),r:(x=>({x:Math.round(x.left+x.width/2),y:Math.round(x.top+x.height/2),w:Math.round(x.width)}))(e.getBoundingClientRect())}));
      const sel=[...document.querySelectorAll('select')].map(e=>({n:e.name||e.id,o:[...e.options].slice(0,4).map(o=>o.value),len:e.options.length}));
      return JSON.stringify({url:location.href,title:document.title.slice(0,60),btns:btns.slice(0,25),ins,sel,body:document.body?document.body.innerText.replace(/\\s+/g,' ').slice(0,300):'NOBODY',dpr:devicePixelRatio});
    })()`);
    console.log(info);
  } else if (sub === 'ev') {
    let js = fs.existsSync(process.argv[4]) && !process.argv[4].startsWith('#') ? fs.readFileSync(process.argv[4], 'utf8') : process.argv[4];
    console.log(JSON.stringify(await ev(js)));
  } else if (sub === 'fill') {
    const sel = process.argv[4], text = process.argv[5];
    const ok = await ev(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NO_EL'; if(el.tagName==='SELECT') return 'IS_SELECT'; el.focus(); return 'FOCUSED'; })()`);
    if (ok !== 'FOCUSED') { console.log('FILL_' + ok); ws.close(); return; }
    await send('Input.insertText', { text });
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await send('Input.insertText', { text: text[text.length - 1] });
    console.log('FILLED', await ev(`(()=>{const el=document.activeElement;return JSON.stringify({tag:el&&el.tagName,len:el&&el.value?el.value.length:0})})()`));
  } else if (sub === 'snap') {
    const r = await send('Page.captureSnapshot', { format: 'mhtml' }, 20000);
    fs.writeFileSync(process.argv[4], r.data);
    console.log('SNAP', fs.statSync(process.argv[4]).size);
  } else if (sub === 'shot') {
    const out = process.argv[4];
    let done = false;
    try {
      const r = await send('Page.captureScreenshot', { format: 'png' }, 5000);
      fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      console.log('SHOT_LIVE', fs.statSync(out).size); done = true;
    } catch (e) { /* fall through */ }
    if (!done) {
      const tmp = path.join('/tmp', 'd4reg-snap-' + Date.now() + '.mhtml');
      const r = await send('Page.captureSnapshot', { format: 'mhtml' }, 20000);
      fs.writeFileSync(tmp, r.data);
      execFileSync('node', [path.join(__dirname, 'mhtml-shot.cjs'), tmp, out], { env: { ...process.env, CHROME_BIN: CHROME } });
      fs.unlinkSync(tmp);
    }
  } else {
    throw new Error('unknown sub ' + sub);
  }
  ws.close();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
