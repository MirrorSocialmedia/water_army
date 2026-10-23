/**
 * P3 host/container resource sampler (detached, 5s cadence) — companion to
 * p3-ladder.mjs. One CSV row every 5s:
 *
 *   ts,mem_avail_mb,cpu_busy_pct,api_cpu_pct,api_rss_mb,sidecar_cpu_pct,
 *   sidecar_rss_mb,gpu_mem_used_mib,gpu_mem_total_mib,gpu_util_pct,devices_csv
 *
 * Column format is identical to logs/mobileconsole-p3/p3-resources.csv
 * (2026-10-23 run) so re-run rows can be merged 1:1.
 *
 * Detach: nohup setsid node p3-sample.mjs OUT >> sampler.log 2>&1 & (pidfile).
 * Stops after MC_DURATION_MS (default 45 min) or SIGTERM. Read-only:
 * /proc, nvidia-smi query, docker stats --no-stream.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT = process.argv[2] ?? '/home/kenneth/.openclaw/workspace/logs/mobileconsole-p3/p3-resources-rerun.csv';
const INTERVAL_MS = 5_000;
const DURATION_MS = Number(process.env.MC_DURATION_MS ?? 45 * 60_000);
const API_PID = Number(fs.readFileSync('/tmp/mobileconsole/api.pid', 'utf8').trim());
const HZ = 100;

try { fs.mkdirSync(OUT.split('/').slice(0, -1).join('/'), { recursive: true }); } catch {}
const isFresh = !fs.existsSync(OUT) || fs.statSync(OUT).size === 0;
if (isFresh) fs.writeFileSync(OUT, 'ts,mem_avail_mb,cpu_busy_pct,api_cpu_pct,api_rss_mb,sidecar_cpu_pct,sidecar_rss_mb,gpu_mem_used_mib,gpu_mem_total_mib,gpu_util_pct,devices_csv\n');

const pad = (n, w = 2) => String(n).padStart(w, '0');
function hkTs() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // wall-clock HK, UTC-based formatting
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}
function procStat() {
  const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  const idle = l[3] + (l[4] ?? 0);
  const total = l.reduce((a, b) => a + b, 0);
  return { idle, total };
}
function pidCpu(pid) {
  // returns [utime+stime ticks, rss_kb] or null
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = f.slice(f.indexOf(')') + 2).split(' ');
    const utime = Number(rest[11]), stime = Number(rest[12]);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/VmRSS:\s+(\d+) kB/);
    return { ticks: utime + stime, rssKb: m ? Number(m[1]) : 0 };
  } catch { return null; }
}
function sidecarPid() {
  try {
    const tasks = fs.readdirSync(`/proc/${API_PID}/task`);
    const kids = new Set();
    for (const t of tasks) {
      const c = fs.readFileSync(`/proc/${API_PID}/task/${t}/children`, 'utf8').trim();
      for (const k of c.split(/\s+/)) if (k) kids.add(Number(k));
    }
    // the sidecar is the node child (the browser/adb children are not node)
    for (const k of kids) {
      try { if (/sidecar/.test(fs.readFileSync(`/proc/${k}/cmdline`, 'utf8'))) return k; } catch {}
    }
    return kids.size === 1 ? [...kids][0] : null;
  } catch { return null; }
}
function gpu() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim().split('\n')[0].split(',').map((s) => s.trim());
    return [Number(out[0]), Number(out[1]), Number(out[2])];
  } catch { return [null, null, null]; }
}
function devices() {
  try {
    const out = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.Name}}~{{.CPUPerc}}~{{.MemUsage}}'], { encoding: 'utf8' }).trim().split('\n');
    return out
      .filter((l) => /redroid/.test(l))
      .map((l) => {
        const [name, cpu, mem] = l.split('~');
        return `${name.replace(/^water-army-/, '')}~${cpu}~${mem}`;
      })
      .join(';');
  } catch { return ''; }
}
function memAvailMb() {
  const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

let prevHost = procStat();
let prevApi = pidCpu(API_PID);
let prevSide = null;
let prevSidePid = null;
const t0 = Date.now();
console.log(`[sample] start → ${OUT} (interval 5s, duration ${DURATION_MS / 60000}min, api pid ${API_PID})`);

function tick() {
  const host = procStat();
  const api = pidCpu(API_PID);
  const sidePid = sidecarPid();
  const side = sidePid ? pidCpu(sidePid) : null;
  const cpuBusy = host.total > prevHost.total ? (100 * (1 - (host.idle - prevHost.idle) / (host.total - prevHost.total))) : 0;
  const cpuOf = (now, prev, pid) => (now && prev && pid ? 100 * (now.ticks - prev.ticks) / HZ / (INTERVAL_MS / 1000) : 0);
  const [gUsed, gTotal, gUtil] = gpu();
  const row = [
    hkTs(),
    memAvailMb() ?? '',
    cpuBusy.toFixed(1),
    cpuOf(api, prevApi, API_PID).toFixed(1),
    api ? Math.round(api.rssKb / 1024) : '',
    sidePid === prevSidePid ? cpuOf(side, prevSide, sidePid).toFixed(1) : '',
    side ? Math.round(side.rssKb / 1024) : '',
    gUsed ?? '', gTotal ?? '', gUtil ?? '',
    devices(),
  ].join(',');
  fs.appendFileSync(OUT, row + '\n');
  prevHost = host; prevApi = api; prevSide = side; prevSidePid = sidePid;
  if (Date.now() - t0 > DURATION_MS) { console.log('[sample] duration reached — stop'); process.exit(0); }
  setTimeout(tick, INTERVAL_MS);
}
tick();
