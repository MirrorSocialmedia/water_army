/**
 * Fake dockerode-shaped client for hermetic tests (施工 MD §16.2).
 *
 * Mirrors the dockerode surface DockerService uses:
 *   client.listContainers / getContainer(id).{inspect,logs,stats,start,stop,
 *   restart,pause,unpause,remove} / getEvents / listNetworks / createContainer
 *
 * Error shapes mirror the real client:
 *   - engine errors:  { statusCode: 404|304|500, message: 'No such container: ...' }
 *   - socket errors:  { code: 'ECONNREFUSED' | 'EACCES' | 'ETIMEDOUT', message }
 *
 * Behaviour mirrors the engine where it matters (304-style idempotency,
 * pause only while running, dead containers cannot start/restart) so
 * service-level tests exercise the real decision paths.
 */
import { EventEmitter } from 'node:events';

let idSeq = 1000;

/**
 * @param {object} [opts]
 * @param {'ok'|'daemon-down'|'permission-denied'|'timeout'} [opts.mode] global failure mode
 * @param {Array<object>} [opts.containers] seed rows (full inspect shapes)
 * @param {string[]} [opts.networks]
 */
export function makeFakeDockerClient({ mode = 'ok', containers = [], networks = ['bridge', 'host', 'none', 'water-army_default'] } = {}) {
  /** @type {Map<string, object>} id → inspect-shaped record */
  const byId = new Map();
  /** @type {Map<string, string>} name → id */
  const byName = new Map();
  /** ids whose mutations resolve but do NOT change state (OPERATION_PENDING tests) */
  const frozen = new Set();
  const calls = []; // audit trail: {method, id, opts}
  const logBuffers = new Map(); // id → Buffer (seedable log output)

  function register(inspectRow) {
    const id = inspectRow.Id ?? inspectRow.id ?? `fake${++idSeq}`.padEnd(64, '0');
    const rec = {
      inspect: {
        Id: id,
        Name: `/${inspectRow.name}`,
        State: {
          Status: inspectRow.state ?? 'running',
          Running: (inspectRow.state ?? 'running') === 'running',
          Paused: (inspectRow.state ?? 'running') === 'paused',
          Restarting: false,
          Dead: (inspectRow.state ?? 'running') === 'dead',
          StartedAt: '2026-10-14T00:00:00.000000000Z',
          FinishedAt: '2026-10-14T00:00:00.000000000Z',
          ExitCode: 0,
          RestartCount: 0,
          Health: null,
        },
        Created: inspectRow.created ?? '2026-10-14T00:00:00.000000000Z',
        Image: 'sha256:fake',
        Config: {
          Labels: inspectRow.labels ?? {},
          Env: inspectRow.env ?? [],
          Cmd: inspectRow.command ?? null,
          Image: inspectRow.image ?? 'alpine:3.20',
        },
        HostConfig: {
          NetworkMode: inspectRow.network ?? 'bridge',
          Privileged: Boolean(inspectRow.privileged),
          PortBindings: null,
        },
        NetworkSettings: { Ports: inspectRow.ports ?? null },
        Mounts: inspectRow.mounts ?? [],
      },
      restarts: 0,
    };
    byId.set(id, rec);
    byName.set(inspectRow.name, id);
    if (inspectRow.logs) logBuffers.set(id, Buffer.from(inspectRow.logs));
    return id;
  }

  for (const c of containers) register(c);

  function record(method, id, opts) {
    calls.push({ method, id, opts: opts ?? null });
  }

  function socketError() {
    if (mode === 'daemon-down') {
      const e = new Error('connect ECONNREFUSED /var/run/docker.sock');
      e.code = 'ECONNREFUSED';
      return e;
    }
    if (mode === 'permission-denied') {
      const e = new Error('open /var/run/docker.sock: permission denied');
      e.code = 'EACCES';
      return e;
    }
    if (mode === 'timeout') {
      const e = new Error('request timed out after 30000ms');
      e.code = 'ETIMEDOUT';
      return e;
    }
    return null;
  }

  function engineError(statusCode, message) {
    const e = new Error(message);
    e.statusCode = statusCode;
    return e;
  }

  function guard() {
    const err = socketError();
    if (err) throw err;
  }

  function resolveId(idOrName) {
    if (byId.has(idOrName)) return byId.get(idOrName);
    const id = byName.get(idOrName);
    if (id) return byId.get(id);
    throw engineError(404, `No such container: ${idOrName}`);
  }

  /** Resolve after microtask — keeps async error shapes faithful. */
  function rejectLater(err) {
    return Promise.reject(err);
  }

  const eventsBus = new EventEmitter(); // harness: push docker events to open streams

  const client = {
    __calls: calls,
    __byId: byId,
    __byName: byName,
    __freeze: (idOrName) => {
      const rec = byId.get(idOrName) ?? byId.get(byName.get(idOrName));
      if (rec) frozen.add(rec.inspect.Id);
    },
    __unfreeze: (idOrName) => {
      const rec = byId.get(idOrName) ?? byId.get(byName.get(idOrName));
      if (rec) frozen.delete(rec.inspect.Id);
    },
    __setLogBuffer: (id, text) => logBuffers.set(id, Buffer.from(text)),
    __pushEvent: (ev) => {
      const payload = JSON.stringify({ Type: 'container', ...ev });
      eventsBus.emit('event', payload);
    },

    async listContainers(_opts) {
      guard();
      record('listContainers', null, _opts);
      return [...byId.values()].map((rec) => {
        const s = rec.inspect;
        const ports = [];
        const pb = s.HostConfig?.PortBindings ?? {};
        for (const [key, binds] of Object.entries(pb)) {
          const [port, type] = key.split('/');
          for (const b of binds ?? []) ports.push({ PrivatePort: Number(port), Type: type, PublicPort: Number(b.HostPort), IP: '0.0.0.0' });
        }
        return {
          Id: s.Id,
          Names: [s.Name],
          Image: s.Config.Image,
          State: s.State.Status,
          Status:
            s.State.Status === 'running'
              ? 'Up 2 hours'
              : s.State.Status === 'exited'
                ? 'Exited (0) 5 minutes ago'
                : s.State.Status,
          Ports: ports,
          Labels: s.Config.Labels,
          Created: Math.floor(new Date(s.Created).getTime() / 1000),
        };
      });
    },

    getContainer(idOrName) {
      guard();
      // resolveId deferred to call-time (async parity with real client)
      return {
        async inspect() {
          record('inspect', idOrName);
          const rec = resolveId(idOrName);
          return JSON.parse(JSON.stringify(rec.inspect));
        },
        async logs(opts) {
          record('logs', idOrName, opts);
          const rec = resolveId(idOrName);
          let buf = logBuffers.get(rec.inspect.Id) ?? Buffer.alloc(0);
          if (opts?.tail && Number(opts.tail) > 0) {
            const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
            buf = Buffer.from(lines.slice(-Number(opts.tail)).join('\n') + '\n');
          }
          // Emit in docker multiplexed frame format (stdout=1).
          const framed = Buffer.alloc(8 + buf.length);
          framed[0] = 1;
          framed.writeUInt32BE(buf.length, 4);
          buf.copy(framed, 8);
          return framed;
        },
        async stats() {
          record('stats', idOrName);
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status !== 'running') {
            throw engineError(500, `container ${idOrName} is not running`);
          }
          return {
            cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 100_000_000_000, online_cpus: 8 },
            precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 99_000_000_000 },
            memory_stats: { usage: 256 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
          };
        },
        async start() {
          record('start', idOrName);
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status === 'dead') throw engineError(500, 'cannot start container: dead');
          if (frozen.has(rec.inspect.Id)) return; // op "succeeds", state stays
          // 304-style: no state change when already running.
          if (rec.inspect.State.Status !== 'running') {
            rec.inspect.State.Status = 'running';
            rec.inspect.State.Running = true;
            rec.inspect.State.Paused = false;
          }
        },
        async stop(opts) {
          record('stop', idOrName, opts);
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status === 'exited') return; // 304-style
          if (frozen.has(rec.inspect.Id)) return; // op "succeeds", state stays
          rec.inspect.State.Status = 'exited';
          rec.inspect.State.Running = false;
          rec.inspect.State.Paused = false;
          rec.inspect.State.FinishedAt = new Date().toISOString();
        },
        async restart(opts) {
          record('restart', idOrName, opts);
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status === 'dead') throw engineError(500, 'cannot restart container: dead');
          if (frozen.has(rec.inspect.Id)) return; // op "succeeds", state stays
          rec.restarts += 1;
          rec.inspect.State.RestartCount = rec.restarts;
          rec.inspect.State.Status = 'running';
          rec.inspect.State.Running = true;
          rec.inspect.State.Paused = false;
        },
        async pause() {
          record('pause', idOrName);
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status !== 'running') throw engineError(500, `container ${idOrName} is not running`);
          rec.inspect.State.Status = 'paused';
          rec.inspect.State.Paused = true;
        },
        async unpause() {
          record('unpause', idOrName);
          const rec = resolveId(idOrName);
          if (rec.inspect.State.Status !== 'paused') throw engineError(500, `container ${idOrName} is not paused`);
          rec.inspect.State.Status = 'running';
          rec.inspect.State.Running = true;
          rec.inspect.State.Paused = false;
        },
        async remove(opts) {
          record('remove', idOrName, opts);
          const rec = resolveId(idOrName);
          const id = rec.inspect.Id;
          if (rec.inspect.State.Status === 'running' && !opts?.force) {
            throw engineError(409, 'you cannot remove a running container: use -f');
          }
          if (frozen.has(id)) return; // remove "succeeds", container stays
          byId.delete(id);
          for (const [n, i] of byName) if (i === id) byName.delete(n);
          logBuffers.delete(id);
        },
      };
    },

    async getEvents(_opts) {
      guard();
      record('getEvents', null, _opts);
      const stream = new EventEmitter();
      stream.destroyed = false;
      stream.on('newListener', (ev) => {
        if (ev === 'event') {
          const forward = (payload) => stream.emit('data', Buffer.from(`${payload}\n`));
          eventsBus.on('event', forward);
          stream._cleanup = () => eventsBus.off('event', forward);
        }
      });
      stream.destroy = () => {
        stream.destroyed = true;
        stream._cleanup?.();
        stream.removeAllListeners();
      };
      return stream;
    },

    async listNetworks() {
      guard();
      record('listNetworks', null);
      return networks.map((Name) => ({ Name }));
    },

    async createContainer(config) {
      guard();
      record('createContainer', null, config);
      const name = String(config?.Name ?? '').replace(/^\//, '');
      if (!name) throw engineError(400, 'container name required');
      if (byName.has(name)) throw engineError(409, `Conflict. The container name "/${name}" is already in use by container`);
      const id = `created${String(++idSeq).padStart(61, '0')}`;
      const rec = {
        inspect: {
          Id: id,
          Name: `/${name}`,
          State: { Status: 'created', Running: false, Paused: false, Restarting: false, Dead: false, StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0, RestartCount: 0, Health: null },
          Created: new Date().toISOString(),
          Image: 'sha256:fake',
          Config: { Labels: config?.Labels ?? {}, Env: config?.Env ?? [], Cmd: config?.Cmd ?? null, Image: config?.Image ?? 'unknown' },
          HostConfig: {
            NetworkMode: config?.HostConfig?.NetworkMode ?? 'bridge',
            Privileged: Boolean(config?.HostConfig?.Privileged),
            NanoCpus: config?.HostConfig?.NanoCpus ?? 0,
            Memory: config?.HostConfig?.Memory ?? 0,
            PortBindings: config?.HostConfig?.PortBindings ?? null,
          },
          NetworkSettings: { Ports: null },
          Mounts: (config?.HostConfig?.Mounts ?? config?.Mounts ?? []).map((m) => ({ Type: m.Type, Source: m.Source ?? null, Destination: m.Target, RW: !m.ReadOnly })),
        },
        restarts: 0,
      };
      byId.set(id, rec);
      byName.set(name, id);
      return { Id: id, Warnings: [] };
    },

    /** Start a just-created container (createContainer leaves it 'created'). */
    async ping() {
      guard();
      return 'PONG';
    },
  };

  // createContainer must be able to start: give created containers a start path
  const origGetContainer = client.getContainer;
  client.getContainer = (idOrName) => {
    const c = origGetContainer(idOrName);
    return c;
  };
  void origGetContainer;
  void rejectLater;

  return client;
}

/**
 * Plugin-shape wrapper ({disabled, client, ping}) around the fake client —
 * what buildApp/dockerService actually consume.
 * @param {object} [clientOpts] see makeFakeDockerClient
 */
export function makeFakeDockerWrapper(clientOpts = {}) {
  const client = makeFakeDockerClient(clientOpts);
  return { disabled: false, client, ping: async () => 'PONG' };
}
