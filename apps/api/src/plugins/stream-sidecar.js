/**
 * MC P2 — stream-sidecar child process manager (ADR-019 §19.12).
 *
 * The sidecar (apps/stream-sidecar) is a plain Node child process — no docker
 * in P2 (the P0 PoC proved the host-process mechanism end-to-end). In the
 * shipped compose topology the same server.js runs in a dedicated container
 * on the devices network (P3 infra work); this plugin then switches to a
 * network client mode via config (P3).
 *
 * Lifecycle (MD §10):
 *  - start on app ready; health-gated (HTTP /health, ~10s deadline)
 *  - crash → restart with backoff, MAX 3 attempts, then fail-closed
 *    (stream WS endpoints return 503 STREAM_SIDECAR_UNAVAILABLE; existing
 *    sessions are dead by definition — their WS tunnels drop and the
 *    lease-level reconcile (P1) reaps the rest)
 *  - SIGTERM on app close (kills all sessions inside the sidecar)
 *
 * The sidecar gets a process-unique STREAM_SIDECAR_TOKEN (env) that the
 * gateway must present on every WS connection — the sidecar never trusts
 * anything from the network (127.0.0.1 binding + token).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_RESTARTS = 3;

function httpJson(path, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
  });
}

/**
 * @param {object} p
 * @param {object} p.app fastify instance (for .log + lifecycle)
 * @param {object} p.config resolved config (must carry streamSidecar* fields)
 * @param {string} p.entryPath absolute path to apps/stream-sidecar/src/server.js
 * @param {object} [p.env] extra env for the child (tests inject)
 */
export function buildStreamSidecarManager({ app, config, entryPath, env = {} }) {
  const port = config.streamSidecarPort;
  const state = {
    child: null,
    status: 'disabled', // disabled | starting | running | degraded | dead
    restarts: 0,
    pid: null,
  };
  let closed = false;
  let starting = null;

  const childEnv = {
    ...process.env,
    ...env,
    SIDECAR_PORT: String(port),
    STREAM_SIDECAR_TOKEN: config.streamSidecarToken,
    SIDECAR_MAX_SESSIONS: String(config.streamSidecarMaxSessions),
    SIDECAR_ZERO_FRAME_MS: String(config.streamZeroFrameMs),
    // ADB allowlist = the API's configured range (single source of truth —
    // the sidecar re-checks the serial against it on every session start).
    SIDECAR_ADB_RANGE_START: String(config.redroidAdbRangeStart),
    SIDECAR_ADB_RANGE_END: String(config.redroidAdbRangeEnd),
    REDROID_ADB_BINARY: config.redroidAdbBinary,
    SCRCPY_JAR: config.scrcpyJar,
    SCRCPY_JAR_SHA256: config.scrcpyJarSha256,
    SCRCPY_JAR_REMOTE: config.scrcpyJarRemote,
    LOG_LEVEL: config.logLevel,
  };

  async function waitForHealth(deadlineMs = 10_000) {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (state.child && state.child.exitCode !== null) return false;
      const r = await httpJson('/health', port);
      if (r.status === 200 && r.body?.ok) return true;
      if (Date.now() + 500 > deadline) return false;
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  function spawnChild() {
    const child = spawn(process.execPath, [entryPath], {
      env: childEnv,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    state.child = child;
    state.pid = child.pid;
    child.on('exit', (code, signal) => {
      state.pid = null;
      if (closed) return;
      app.log.warn({ code, signal, restarts: state.restarts }, 'stream-sidecar exited');
      if (state.restarts < MAX_RESTARTS) {
        state.restarts += 1;
        state.status = 'starting';
        const backoff = 1000 * state.restarts;
        setTimeout(() => {
          if (!closed) void start();
        }, backoff).unref?.();
      } else {
        state.status = 'dead';
        app.log.error({ code, signal }, 'stream-sidecar dead after max restarts — stream console FAIL-CLOSED (503 STREAM_SIDECAR_UNAVAILABLE)');
      }
    });
    child.on('error', (e) => {
      state.status = 'dead';
      app.log.error({ e: String(e) }, 'stream-sidecar spawn error');
    });
  }

  async function start() {
    if (!config.streamSidecarToken) {
      state.status = 'disabled';
      app.log.warn('stream-sidecar disabled: STREAM_SIDECAR_TOKEN unset (console streaming fail-closed)');
      return false;
    }
    if (state.status === 'running' || starting) return state.status === 'running';
    state.status = 'starting';
    if (!starting) {
      starting = (async () => {
        try {
          spawnChild();
          const ok = await waitForHealth();
          if (ok) state.status = 'running';
          else {
            state.status = state.restarts < MAX_RESTARTS ? 'starting' : 'dead';
            try { state.child?.kill('SIGKILL'); } catch {}
          }
          return ok;
        } finally {
          // CRITICAL: clear the in-flight marker — the restart backoff path
          // re-enters start() and must not see a stale resolved promise or it
          // returns early forever (sidecar dead after first health failure).
          starting = null;
        }
      })();
    }
    return starting;
  }

  async function stop() {
    closed = true;
    const child = state.child;
    if (!child || child.exitCode !== null) { state.status = 'dead'; return; }
    await new Promise((res) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} res(); }, 3_000);
      child.once('exit', () => { clearTimeout(t); res(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(t); res(); }
    });
    state.status = 'dead';
  }

  /** Live session summaries straight from the sidecar (ops/health). */
  async function sessions() {
    if (state.status !== 'running') return { available: false, sessions: [] };
    const r = await httpJson('/sessions', port, 3_000);
    if (r.status !== 200 || !r.body) return { available: false, sessions: [] };
    return { available: true, ...r.body };
  }

  // graceful shutdown
  app.addHook('onClose', async () => { await stop(); });

  app.decorate('streamSidecar', {
    port,
    /** @returns {'disabled'|'starting'|'running'|'degraded'|'dead'} */
    status: () => state.status,
    isReady: () => state.status === 'running',
    start: () => start(),
    stop: () => stop(),
    sessions,
    health: () => httpJson('/health', port).then((r) => ({
      reachable: r.status === 200 && Boolean(r.body?.ok),
      status: state.status,
      pid: state.pid,
      restarts: state.restarts,
      sessions: r.body?.sessions ?? null,
    })),
  });

  return app;
}

export const STREAM_SIDECAR_ENTRY = fileURLToPath(new URL('../../../stream-sidecar/src/server.js', import.meta.url));
