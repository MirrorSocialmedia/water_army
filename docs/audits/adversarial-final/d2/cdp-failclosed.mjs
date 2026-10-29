// fail-closed check: WebView fetch through tun chain (expect failure when sidecar down)
const PORT = process.argv[2], DEV = process.argv[3];
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t => t.type === 'page') || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const r = await send('Runtime.evaluate', { expression: `new Promise(function(res){var done=false;var p=fetch('https://ipinfo.io/ip?t=failclosed',{cache:'no-store'}).then(function(r){return r.text()}).then(function(t){done=true;res('OK:'+t.trim())}).catch(function(e){done=true;res('FETCHERR:'+e.message)});setTimeout(function(){if(!done)res('TIMEOUT-12s')},12000);})`, awaitPromise: true, returnByValue: true });
console.log(`FAILCLOSED ${DEV}:`, r.result?.result?.value || JSON.stringify(r.result?.exceptionDetails || {}).slice(0, 150));
ws.close(); process.exit(0);
