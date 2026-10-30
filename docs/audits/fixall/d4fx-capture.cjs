// WA-FIXALL S1 chunk-wall root-cause capture (gen1, 2026-10-30)
// One-shot: attach page target, Network+Page domain, navigate signup, fill name, click Next,
// record ALL network events (esp gstatic boq chunks) + performance entries.
// Usage: node d4fx-capture.cjs <cdpHttpBase> <outPrefix> [signupUrl]
const fs = require('fs');
const base = process.argv[2];
const outPrefix = process.argv[3];
const signupUrl = process.argv[4] || 'https://accounts.google.com/signup';

async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
    .find(t => /accounts\.google/.test(t.url)) || targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0];
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let id = 0; const pend = new Map();
  const send = (m, p, tmo = 15000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP timeout ' + m)); } }, tmo);
  });
  const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result); return; }
    if (m.method) events.push({ t: Date.now(), method: m.method, params: m.params });
  };
  const ev = async (expr, tmo = 15000) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false }, tmo); return r.result && r.result.value; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  await send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable').catch(() => {});

  const step = async (label) => {
    const info = await ev(`JSON.stringify({url:location.href,title:document.title.slice(0,50),bloks:typeof window.Bloks,
      inputs:[...document.querySelectorAll('input')].map(e=>({t:e.type,id:(e.id||'').slice(0,20),n:(e.name||'').slice(0,15),ph:(e.placeholder||'').slice(0,20),w:e.offsetWidth})).slice(0,10),
      btns:[...document.querySelectorAll('button,[role=button],a[role=button]')].map(e=>({t:(e.innerText||'').trim().slice(0,20),w:e.offsetWidth,x:Math.round(e.getBoundingClientRect().left+e.getBoundingClientRect().width/2),y:Math.round(e.getBoundingClientRect().top+e.getBoundingClientRect().height/2)})).filter(b=>b.t).slice(0,10),
      perfChunks:performance.getEntriesByType('resource').filter(r=>/gstatic|boq/.test(r.name)).map(r=>({n:r.name.slice(-42),dbs:r.decodedBodySize,ts:r.transferSize,dur:Math.round(r.duration),rs:r.responseStatus})).slice(-20)})`);
    fs.appendFileSync(outPrefix + '-steps.log', label + ' => ' + info + '\n');
    return info;
  };

  // 1) navigate fresh signup
  try { await send('Page.navigate', { url: signupUrl }, 10000); } catch (e) { fs.appendFileSync(outPrefix + '-steps.log', 'NAV_ACK_TIMEOUT\n'); }
  await sleep(6000);
  await step('after-nav');

  // 2) fill name via native setter (R39 lesson: no wake-hack)
  await ev("(() => {\n    const setV=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};\n    const ins=[...document.querySelectorAll('input[type=text]')].filter(e=>e.offsetWidth>0);\n    if(ins.length>=2){setV(ins[0],'Daniel');setV(ins[1],'Rowe');return 'FILLED '+ins.length;}\n    return 'NOFIELDS '+ins.length;\n  })()")
  await sleep(500);
  await step('after-fill');

  // 3) click Next via CDP trusted mouse (R36 proven pattern)
  const nextBtn = await ev(`(() => {
    const b=[...document.querySelectorAll('button,[role=button],a[role=button]')].filter(e=>/next|submit|continue/i.test(e.innerText||'')&&e.offsetWidth>0)[0];
    if(!b)return 'NOBTN'; const r=b.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
  })()`);
  fs.appendFileSync(outPrefix + '-steps.log', 'nextBtn => ' + nextBtn + '\n');
  if (nextBtn && nextBtn !== 'NOBTN') {
    const { x, y } = JSON.parse(nextBtn);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseReleased' ? 1 : 1, buttons: type === 'mouseReleased' ? 0 : 1 });
    }
    await sleep(4000);
    await step('after-click+4s');
    await sleep(4000);
    await step('after-click+8s');
  }

  // 4) dump network events
  const net = events.filter(e => /^Network\./.test(e.method)).map(e => {
    const p = e.params || {};
    return { t: e.t - events[0].t, m: e.method.replace('Network.', ''), id: p.requestId, url: (p.request && p.request.url || p.response && p.response.url || '').slice(0, 130), type: (p.type || ''), status: p.response && p.response.status, err: p.errorText, canceled: p.canceled, len: p.encodedDataLength, mon: p.monotonicTime, init: p.initiator && p.initiator.type };
  });
  fs.writeFileSync(outPrefix + '-net.json', JSON.stringify(net, null, 0));
  // 5) JS-level events: exceptions, console/log entries
  const jsEv = events.filter(e => /^(Runtime\.exceptionThrown|Log\.entryAdded|Page\.javascriptDialogOpening|Runtime\.consoleAPICalled)$/.test(e.method)).map(e => {
    const p = e.params || {};
    if (e.method === 'Log.entryAdded') return { t: e.t - events[0].t, m: 'log', sev: p.entry && p.entry.level, src: p.entry && p.entry.source, text: p.entry && ('' + p.entry.text).slice(0, 200), url: p.entry && (p.entry.url || '').slice(0, 90) };
    if (e.method === 'Runtime.exceptionThrown') return { t: e.t - events[0].t, m: 'exc', text: JSON.stringify(p.exceptionDetails && (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text) || p).slice(0, 300) };
    if (e.method === 'Runtime.consoleAPICalled') return { t: e.t - events[0].t, m: 'con', sev: p.type, text: (p.args || []).map(a => JSON.stringify(a.value !== undefined ? a.value : a.description || a.type).slice(0, 80)).join(' ').slice(0, 200) };
    return { t: e.t - events[0].t, m: 'dlg' };
  });
  fs.writeFileSync(outPrefix + '-js.json', JSON.stringify(jsEv, null, 0));
  fs.appendFileSync(outPrefix + '-steps.log', 'JS_EVENTS ' + jsEv.length + '\n');
  for (const x of jsEv.slice(0, 40)) fs.appendFileSync(outPrefix + '-steps.log', ' ' + JSON.stringify(x).slice(0, 260) + '\n');
  fs.appendFileSync(outPrefix + '-steps.log', 'NET_EVENTS_TOTAL ' + net.length + '\n');
  // summary: chunk-related final states
  const chunks = net.filter(x => /gstatic|boq|\/_\//.test(x.url));
  fs.appendFileSync(outPrefix + '-steps.log', 'CHUNK_EVENTS ' + chunks.length + '\n');
  for (const c of chunks.slice(0, 80)) fs.appendFileSync(outPrefix + '-steps.log', ' ' + c.m + ' ' + (c.id || '').slice(0, 8) + ' ' + (c.url || '').slice(-45) + (c.status ? ' ' + c.status : '') + (c.err ? ' ERR:' + c.err : '') + (c.canceled ? ' CANCELED' : '') + (c.len != null ? ' len=' + c.len : '') + '\n');
  ws.close();
}
main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
