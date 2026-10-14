#!/usr/bin/env node
/**
 * Dev process supervisor (zero dependencies).
 * Runs api + worker + web concurrently; exits when any child exits.
 * Production deployment uses docker compose (see compose.yaml).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const procs = [
  { name: 'api', cmd: process.execPath, args: ['--watch', path.join(root, 'apps/api/src/server.js')] },
  { name: 'worker', cmd: process.execPath, args: ['--watch', path.join(root, 'apps/worker/src/worker.js')] },
  { name: 'web', cmd: 'npm', args: ['run', 'dev', '--workspace=@water-army/web'] },
];

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 3000).unref();
}

for (const proc of procs) {
  const child = spawn(proc.cmd, proc.args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  children.push(child);
  child.on('exit', (code, signal) => {
    console.error(`[dev] ${proc.name} exited (code=${code ?? signal}) — shutting down all`);
    shutdown(code ?? 1);
  });
  child.on('error', (err) => {
    console.error(`[dev] failed to start ${proc.name}: ${err.message}`);
    shutdown(1);
  });
  console.error(`[dev] started ${proc.name} (pid ${child.pid})`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0));
}
