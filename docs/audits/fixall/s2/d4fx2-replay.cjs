// S2 target-D replay: gen1 S1 規避包 (overlay + anti-throttle + pointer-chain + IME) + candA SF props on fx1/stealth4.
// Walks name -> birthday -> USERNAME -> password (fill, NO submit). At each step:
//  - Page.captureScreenshot (12s timeout) => BeginFrame alive? saves s2/d4fx2-<step>.png
//  - rAF probe: count rAF fires in 2.5s (R56 method, two-phase sync read)
// Usage: PW='...' node d4fx2-replay.cjs <cdpBase>
const base = process.argv[2];
const PW = process.env.PW || '';
const fs = require('fs'), path = require('path');
(async () => {
  const ts = await (await fetch(base + '/json/list')).json();
  const p = ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0];
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  const send = (m, pp, t = 10000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: pp || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('tmo ' + m)); } }, t);
  });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error((m.error.message || '').slice(0, 100))) : res(m.result); } };
  const ev = async (x, t = 10000) => { const r = await send('Runtime.evaluate', { returnByValue: true, expression: x }, t); if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || '').slice(0, 140); return typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value); };
  const log = (k, v) => console.log(k + ' ' + v);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await send('Page.enable');

  // BeginFrame probe: captureScreenshot + rAF count
  const shot = async (name) => {
    try {
      const t0 = Date.now();
      const s = await send('Page.captureScreenshot', { format: 'png' }, 12000);
      const f = path.join(__dirname, 'd4fx2-' + name + '.png');
      fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
      log('SHOT-' + name, 'OK ' + fs.statSync(f).size + 'B ' + (Date.now() - t0) + 'ms');
    } catch (e) { log('SHOT-' + name, 'FAIL(tmo) ' + e.message); }
  };
  const rafProbe = async () => {
    await ev(`(()=>{window.__rafN=0;const cb=(t)=>{window.__rafN++;requestAnimationFrame(cb)};requestAnimationFrame(cb);})()`);
    await sleep(2500);
    return await ev(`String(window.__rafN)`);
  };

  try { await send('Page.navigate', { url: 'https://accounts.google.com/signup' }, 9000); } catch (e) { log('NAV', 'ack-timeout(ok)'); }
  await sleep(1500);
  try { await send('Emulation.enable').catch(() => {}); } catch (e) {}
  try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) { log('FOCUSEMUL', 'FAIL'); }
  try { await send('Page.setWebLifecycleState', { state: 'active' }); } catch (e) { log('LIFECYCLE', 'FAIL'); }
  log('VIS', await ev(`JSON.stringify({vis:document.visibilityState,hidden:document.hidden})`));

  const poll = async (name, jsSel, n = 40) => {
    for (let i = 0; i < n; i++) { const v = await ev(jsSel); if (v === 'true') { log(name, 'OK@' + (i * 0.5) + 's'); return true; } await sleep(500); }
    log(name, 'STUCK ' + await ev(`JSON.stringify({url:location.href.slice(25,70),h1:(document.querySelector('h1')||{}).innerText||'',ids:[...document.querySelectorAll('input,select,[role=radio],button')].map(e=>e.id||e.name||(e.innerText||'').trim().slice(0,8)).slice(0,10)})`));
    return false;
  };
  if (!await poll('NAMESTEP', `(()=>String(!!document.getElementById('firstName')))()`)) { await shot('stuck'); ws.close(); return; }
  log('RAF-name', await rafProbe()); await shot('name');

  const ime = async (sel, txt) => {
    const ok = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'NO';e.focus();return String(document.activeElement===e)})()`);
    if (ok === 'true') { await send('Input.insertText', { text: txt }); return 'FILLED'; }
    return 'FOCUS_' + ok;
  };
  const clickBtn = async (label) => await ev(`(()=>{
    const b=[...document.querySelectorAll('button,[role=button]')].find(e=>(e.innerText||'').trim()===${JSON.stringify(label)}&&e.offsetWidth>0);
    if(!b)return 'NOBTN';
    const r=b.getBoundingClientRect();
    const o={bubbles:true,cancelable:true,composed:true,pointerId:1,isPrimary:true,button:0,buttons:1,clientX:r.left+r.width/2,clientY:r.top+r.height/2,detail:1};
    ['pointerover','pointerdown','pointerup','pointerout','mouseover','mousedown','mouseup','click'].forEach(t=>b.dispatchEvent(new (t.startsWith('pointer')?PointerEvent:MouseEvent)(t,o)));
    return 'DISPATCHED'})()`);

  // name step
  log('F-NAME', await ime('#firstName', 'Daniel') + '/' + await ime('#lastName', 'Rowe'));
  log('C-NAME', await clickBtn('Next'));
  if (!await poll('BIRTHDAY', `(()=>String(!!document.getElementById('day')))()`)) { await shot('birth-stuck'); ws.close(); return; }
  log('RAF-birth', await rafProbe()); await shot('birthday');

  log('F-MONTH', await ev(`(()=>{const m=document.querySelector('#month');if(!m)return 'NO';if(m.tagName==='SELECT'){const opt=[...m.options].find(o=>/^march$/i.test(o.textContent.trim()));if(!opt)return 'NO_MARCH_OPT';const s=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;s.call(m,opt.value);m.dispatchEvent(new Event('change',{bubbles:true}));return 'NATIVE_SET:'+opt.value}m.click();return 'CUSTOM_OPENED'})()`));
  await sleep(400);
  log('F-MONTH2', await ev(`(()=>{const pchain=(el)=>{const r=el.getBoundingClientRect();const o={bubbles:true,cancelable:true,composed:true,pointerId:1,isPrimary:true,button:0,buttons:1,clientX:r.left+r.width/2,clientY:r.top+r.height/2,detail:1};['pointerover','pointerdown','pointerup','pointerout','mouseover','mousedown','mouseup','click'].forEach(t=>el.dispatchEvent(new (t.startsWith('pointer')?PointerEvent:MouseEvent)(t,o)))};
    const pick=(ulText,liText)=>{const uls=[...document.querySelectorAll('ul')].filter(u=>[...u.children].some(c=>(c.innerText||'').trim()===ulText));if(!uls.length)return 'NO_UL';const ul=uls[uls.length-1];const li=[...ul.children].find(c=>(c.innerText||'').trim()===liText);if(!li)return 'NO_LI';pchain(li);return 'OK'};
    if(document.querySelector('#month').tagName==='SELECT')return 'NATIVE_OK';
    const r1=pick('January','March');const r2=pick('Female','Male');return r1+'/'+r2})()`));
  log('F-DY', await ime('#day', '14') + '/' + await ime('#year', '1991'));
  log('GENDER', await ev(`(()=>{const g=[...document.querySelectorAll('input[type=radio],[role=radio]')].filter(e=>/male/i.test(e.value||e.getAttribute('aria-label')||'')&&!/female/i.test(e.value||''));if(!g.length)return 'NO_GENDER';g[0].click();return 'OK'})()`));
  log('C-BIRTH', await clickBtn('Next'));
  if (!await poll('USERNAME', `(()=>{const u=document.getElementById('newUser');return String(!!(u&&u.offsetWidth>0))})()`)) { await shot('user-stuck'); ws.close(); return; }
  log('RAF-username', await rafProbe());
  log('VERDICT-USERNAME', 'REACHED (gen1 wall broken)');
  await shot('username');

  // fill username, advance to password; NO submit of final form
  log('C-USER', await clickBtn('Next'));
  log('F-USER', await ime('#newUser', 'danielrowe7144'));
  await sleep(800);
  log('C-USER2', await clickBtn('Next'));
  if (!await poll('PASSWORD', `(()=>{const p=[...document.querySelectorAll('input[type=password]')].filter(e=>e.offsetWidth>0);return String(p.length>=2)})()`)) { await shot('pw-stuck'); ws.close(); return; }
  const ps = await ev(`(()=>{const ps=[...document.querySelectorAll('input[type=password]')].filter(e=>e.offsetWidth>0);ps[0].focus();return String(document.activeElement===ps[0])})()`);
  if (ps === 'true') await send('Input.insertText', { text: PW });
  const ps2 = await ev(`(()=>{const ps=[...document.querySelectorAll('input[type=password]')].filter(e=>e.offsetWidth>0);if(ps.length<2)return 'NO2';ps[1].focus();return String(document.activeElement===ps[1])})()`);
  if (ps2 === 'true') await send('Input.insertText', { text: PW });
  log('FINAL', await ev(`JSON.stringify({url:location.href.slice(0,90),pw:[...document.querySelectorAll('input[type=password]')].map(e=>(e.value||'').length).join(','),vis:document.visibilityState})`));
  await shot('password');
  ws.close();
})().catch(e => console.log('ERR', e.message));
