/**
 * tests/helpers/ramgate-fake-redis.js — hermetic fake for the RAM gate's
 * Redis surface (RAM-G1).
 *
 * Fidelity contract: `eval(script, numkeys, ...keys, ...args)` (ioredis-native
 * convention) is dispatched on the
 * EXACT script text (the real Lua constants from @water-army/shared) and
 * each handler re-implements that script's semantics 1:1 in JS — including
 * the dead-lease pruning and the check-then-write INSIDE one call (the
 * unit-level stand-in for Redis server-side atomicity). Real-server
 * atomicity is proven separately: env-gated real-redis tests + the G1
 * integration sandbox (br-b6g).
 *
 * Expiry: PX/EX are honoured lazily (on read), driven by an injectable
 * clock so TTL-expiry tests don't sleep.
 */
import {
  ADMIT_LUA,
  DRY_RUN_LUA,
  RELEASE_LUA,
  RELEASE_BY_KEY_LUA,
  RENEW_LUA,
  COUNT_LUA,
} from '@water-army/shared';

export function makeFakeRamRedis({ now = () => Date.now() } = {}) {
  const kv = new Map(); // key -> { value: string, expiresAt: number|null }
  const sets = new Map(); // key -> Set<string>
  const lists = new Map(); // key -> string[] (decisions ring)
  const errors = []; // eval failures forced by tests

  function alive(k) {
    const e = kv.get(k);
    if (!e) return false;
    if (e.expiresAt !== null && now() > e.expiresAt) {
      kv.delete(k);
      return false;
    }
    return true;
  }
  function setExpiry(k, ms) {
    const e = kv.get(k);
    if (e) e.expiresAt = ms == null ? null : now() + ms;
  }

  /** Shared pruning pass (every script prunes before counting). */
  function prunedCount(liveKey) {
    const members = sets.get(liveKey);
    if (!members) return 0;
    let n = 0;
    for (const m of [...members]) {
      if (alive(m)) n += 1;
      else members.delete(m);
    }
    return n;
  }

  function runAdmitLike({ write }, keys, args) {
    const [liveKey, leaseKey] = keys;
    const ttlMs = Number(args[0]);
    const [maxParallel, hardFloor, target, budget, current, reservations, value] = [
      Number(args[write ? 1 : 0]),
      Number(args[write ? 2 : 1]),
      Number(args[write ? 3 : 2]),
      Number(args[write ? 4 : 3]),
      Number(args[write ? 5 : 4]),
      Number(args[write ? 6 : 5]),
      write ? String(args[7]) : null,
    ];
    const n = prunedCount(liveKey);
    // self-renewal: the entity's own live lease is a renewal, not a new
    // commitment (mirrors the real Lua — a retry storm must not
    // self-deadlock at the cap). Only meaningful for the write path.
    const own = write && alive(leaseKey);
    const others = n - (own ? 1 : 0);
    const projected = Math.round(current - (others + 1) * budget - reservations);
    let decision = 0;
    let reason;
    if (others + 1 > maxParallel) reason = 'MAX_PARALLEL';
    else if (current < hardFloor) reason = 'BELOW_HARD_FLOOR';
    else if (projected < target) reason = 'PROJECTED_BELOW_TARGET';
    else {
      decision = 1;
      reason = 'ADMITTED';
    }
    if (write && decision === 1) {
      kv.set(leaseKey, { value, expiresAt: now() + ttlMs });
      if (!sets.has(liveKey)) sets.set(liveKey, new Set());
      sets.get(liveKey).add(leaseKey);
      return [1, others + 1, projected, reason];
    }
    if (write) return [0, n, projected, reason];
    return [decision, n, projected, reason];
  }

  const evalImpl = async (script, numkeys, ...rest) => {
    if (errors.length > 0) throw new Error(errors[0]);
    const K = rest.slice(0, numkeys).map(String);
    const A = rest.slice(numkeys).map(String);
    if (script === ADMIT_LUA) return runAdmitLike({ write: true }, K, A);
    if (script === DRY_RUN_LUA) return runAdmitLike({ write: false }, K, A);
    if (script === COUNT_LUA) return [prunedCount(K[0])];
    if (script === RELEASE_LUA) {
      const [liveKey, leaseKey] = K;
      if (!alive(leaseKey)) return 0;
      let decoded = null;
      try {
        decoded = JSON.parse(kv.get(leaseKey).value);
      } catch {
        /* undecodable → not ours */
      }
      if (decoded && decoded.a === A[0]) {
        kv.delete(leaseKey);
        sets.get(liveKey)?.delete(leaseKey);
        return 1;
      }
      return 0;
    }
    if (script === RELEASE_BY_KEY_LUA) {
      const [liveKey, leaseKey] = K;
      if (!alive(leaseKey)) return [0, ''];
      const val = kv.get(leaseKey).value;
      kv.delete(leaseKey);
      sets.get(liveKey)?.delete(leaseKey);
      return [1, val];
    }
    if (script === RENEW_LUA) {
      if (!alive(K[1])) return 0;
      setExpiry(K[1], Number(A[0]));
      return 1;
    }
    throw new Error(`fake-ram-redis: unknown script (not one of the RAM-G1 Lua constants)`);
  };

  return {
    // --- the gate's required surface ---
    eval: evalImpl,
    async ping() {
      return 'PONG';
    },
    async get(k) {
      return alive(k) ? kv.get(k).value : null;
    },
    async set(k, v, ...mods) {
      kv.set(k, { value: String(v), expiresAt: null });
      // ioredis-style: SET key val PX ms | EX s
      for (let i = 0; i + 1 < mods.length; i += 2) {
        const unit = String(mods[i]).toUpperCase();
        const n = Number(mods[i + 1]);
        if (unit === 'PX') kv.get(k).expiresAt = now() + n;
        else if (unit === 'EX') kv.get(k).expiresAt = now() + n * 1000;
      }
      return 'OK';
    },
    async del(...ks) {
      let n = 0;
      for (const k of ks) if (kv.delete(k)) n += 1;
      return n;
    },
    async exists(k) {
      return alive(k) ? 1 : 0;
    },
    async smembers(k) {
      const members = sets.get(k);
      if (!members) return [];
      // prune dead
      for (const m of [...members]) if (!alive(m)) members.delete(m);
      return [...members];
    },
    async sadd(k, ...ms) {
      if (!sets.has(k)) sets.set(k, new Set());
      let n = 0;
      for (const m of ms) if (!sets.get(k).has(m)) {
        sets.get(k).add(m);
        n += 1;
      }
      return n;
    },
    async srem(k, ...ms) {
      let n = 0;
      for (const m of ms) if (sets.get(k)?.delete(m)) n += 1;
      return n;
    },
    async mget(...ks) {
      const flat = ks.length === 1 && Array.isArray(ks[0]) ? ks[0] : ks;
      return flat.map((k) => (alive(k) ? kv.get(k).value : null));
    },
    async rpush(k, v) {
      if (!lists.has(k)) lists.set(k, []);
      lists.get(k).push(String(v));
      return lists.get(k).length;
    },
    async ltrim(k, from, to) {
      const l = lists.get(k) ?? [];
      const n = l.length;
      const idx = (i) => (i < 0 ? Math.max(0, n + i) : Math.min(n - 1, i));
      const a = idx(from);
      const b = idx(to);
      lists.set(k, b >= a ? l.slice(a, b + 1) : []);
      return 'OK';
    },
    async lrange(k, from, to) {
      const l = lists.get(k) ?? [];
      const n = l.length;
      const idx = (i) => (i < 0 ? Math.max(0, n + i) : Math.min(n - 1, i));
      const a = idx(from);
      const b = idx(to);
      return b >= a ? l.slice(a, b + 1) : [];
    },
    // --- test controls ---
    __kv: kv,
    __sets: sets,
    __lists: lists,
    __failEval: (msg) => errors.push(msg),
    __clearFailures: () => errors.splice(0, errors.length),
    __advance: (ms) => {
      /* expiry is lazy + clock-injected; this exists for API symmetry */
      void ms;
    },
  };
}
