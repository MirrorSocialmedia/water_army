// DNS resolver geo probe via ipinfo /dns json (accept: application/json)
const PORT = process.argv[2], DEV = process.argv[3];
import { writeFileSync } from 'node:fs';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t => t.type === 'page') || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const r = await send('Runtime.evaluate', { expression: `fetch('https://ipinfo.io/dns/json',{headers:{accept:'application/json'}}).then(r=>r.json()).then(j=>JSON.stringify(j.dns||j)).catch(e=>'ERR:'+e)`, awaitPromise: true, returnByValue: true });
const val = r.result?.result?.value;
console.log('DNSWHOAMI', DEV, val);
writeFileSync(`dns-whoami-${DEV}.json`, JSON.stringify({ ts: new Date().toISOString(), dev: DEV, raw: val, dns: (() => { try { return JSON.parse(val); } catch { return null; } })() }, null, 1));
ws.close(); process.exit(0);
