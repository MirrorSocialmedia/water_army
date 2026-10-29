// D2 container-side network probes via WebView CDP (real device network stack: tun→sidecar→upstream)
// Usage: node cdp-net.mjs <hostPort> <dev>  -> d2/net-<dev>.json
import { writeFileSync } from 'node:fs';
const D2 = '/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2';
const PORT = process.argv[2], DEV = process.argv[3];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t => t.type === 'page') || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression, awaitP = true) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: awaitP, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('EX: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'https://ipinfo.io/' }); // https page: fetch same-origin-ish, secure ctx
await new Promise(r => setTimeout(r, 4000));

const out = { ts: new Date().toISOString(), dev: DEV };
const J = (s) => { try { return JSON.parse(s); } catch { return null; } };
out.egress = await evalJs(`fetch('https://ipinfo.io/ip',{cache:'no-store'}).then(r=>r.text()).then(t=>t.trim()).catch(e=>'ERR:'+e)`);
out.geo = await evalJs(`fetch('https://ipinfo.io/json').then(r=>r.json()).then(j=>JSON.stringify({ip:j.ip,city:j.city,country:j.country,org:j.org})).catch(e=>'ERR:'+e)`);
out.dnsWhoami = await evalJs(`fetch('https://ipinfo.io/dns').then(r=>r.json()).then(j=>JSON.stringify(j.dns||j)).catch(e=>'ERR:'+e)`);
out.tlsProbe = await evalJs(`new Promise(function(res){var done=false;fetch('https://httpbin.org/status/200',{cache:'no-store'}).then(function(r){done=true;res('httpbin:'+r.status)}).catch(function(e){done=true;res('ERR:'+e.message)});setTimeout(function(){if(!done)res('TIMEOUT-10s')},10000);})`);
out.loc = await evalJs(`JSON.stringify({lang:navigator.language,tz:Intl.DateTimeFormat().resolvedOptions().timeZone})`);

writeFileSync(`${D2}/net-${DEV}.json`, JSON.stringify({ ...out, geo: J(out.geo), dns: J(out.dnsWhoami), loc: J(out.loc), ts_end: new Date().toISOString() }, null, 1));
ws.close(); process.exit(0);
