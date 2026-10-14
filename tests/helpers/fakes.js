/**
 * Test fixtures — in-memory fakes for db/redis/docker + a standard test
 * config. Kept dependency-free so the suite runs anywhere Node ≥22 runs.
 */

/**
 * @param {object} [opts]
 * @param {Array<{id?:string, username:string, passwordHash:string, role?:string, isActive?:boolean}>} [opts.users]
 */
export function makeFakeDb({ users = [] } = {}) {
  const userRows = new Map(); // by username
  const userById = new Map();
  for (const u of users) {
    const row = {
      id: u.id ?? `u${userRows.size + 1}`,
      username: u.username,
      passwordHash: u.passwordHash,
      role: u.role ?? 'viewer',
      isActive: u.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
    };
    userRows.set(row.username, row);
    userById.set(row.id, row);
  }

  const sessionRows = new Map(); // by tokenHash
  const auditRows = [];
  let sessionSeq = 0;

  const db = {
    user: {
      findUnique: async ({ where }) =>
        typeof where.username === 'string' ? userRows.get(where.username) ?? null : userById.get(where.id) ?? null,
      create: async ({ data }) => {
        const row = {
          id: data.id ?? `u${userRows.size + 1}`,
          username: data.username,
          passwordHash: data.passwordHash,
          role: data.role ?? 'viewer',
          isActive: data.isActive ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastLoginAt: null,
        };
        userRows.set(row.username, row);
        userById.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = userById.get(where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      },
      count: async () => userRows.size,
    },
    session: {
      findUnique: async ({ where }) => {
        const row = sessionRows.get(where.tokenHash);
        if (!row) return null;
        // mimic prisma include: { user: true }
        return { ...row, user: userById.get(row.userId) ?? null };
      },
      create: async ({ data }) => {
        sessionSeq += 1;
        const row = {
          id: `s${sessionSeq}`,
          tokenHash: data.tokenHash,
          userId: data.userId,
          expiresAt: data.expiresAt,
          createdAt: new Date(),
          lastSeenAt: new Date(),
        };
        sessionRows.set(row.tokenHash, row);
        return row;
      },
      delete: async ({ where }) => {
        for (const [k, v] of sessionRows) if (v.id === where.id) sessionRows.delete(k);
        return {};
      },
      update: async ({ where, data }) => {
        for (const v of sessionRows.values()) if (v.id === where.id) Object.assign(v, data);
        return {};
      },
    },
    auditEvent: {
      create: async ({ data }) => {
        const row = { id: `a${auditRows.length + 1}`, createdAt: new Date(), ...data };
        auditRows.push(row);
        return row;
      },
    },
    // health/ready probe
    $queryRaw: async () => [{}],
    // teardown seam
    $disconnect: async () => {},
    __state: { userRows, userById, sessionRows, auditRows },
  };
  return db;
}

export const fakeRedisOk = () => ({
  ping: async () => 'PONG',
  on: () => {},
  quit: async () => {},
});

export const fakeRedisDown = () => ({
  ping: async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');
    err.code = 'ECONNREFUSED';
    throw err;
  },
  on: () => {},
  quit: async () => {},
});

export const fakeDockerOk = () => ({ disabled: false, client: null, ping: async () => 'PONG' });

export const fakeDockerDown = () => ({
  disabled: false,
  client: null,
  ping: async () => {
    const err = new Error('connect ENOENT /var/run/docker.sock');
    err.code = 'ENOENT';
    throw err;
  },
});

export const fakeDockerDisabled = () => ({
  disabled: true,
  client: null,
  ping: async () => {
    const err = new Error('Docker checks disabled via config (DOCKER_SOCKET_PATH empty)');
    err.code = 'DOCKER_DISABLED';
    throw err;
  },
});

export function dbDownFake() {
  return {
    user: {},
    session: {},
    auditEvent: {},
    $queryRaw: async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      err.code = 'ECONNREFUSED';
      throw err;
    },
    $disconnect: async () => {},
  };
}

/** Standard hermetic config (no env access). */
export const testConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  publicUrl: 'http://127.0.0.1:3012',
  sessionSecret: 'a'.repeat(48),
  encryptionKey: 'b'.repeat(48),
  sessionTtlMs: 3_600_000,
  cookieSecure: false,
  databaseUrl: 'postgresql://x:y@127.0.0.1:1/x',
  redisUrl: 'redis://127.0.0.1:1',
  dockerSocketPath: '/nonexistent',
  defaultTimezone: 'Asia/Taipei',
  taskDefaultTimeoutMs: 120_000,
  taskMaxTimeoutMs: 900_000,
  taskDefaultAttempts: 3,
  taskMaxConcurrency: 4,
  logLevel: 'silent',
  allowedOrigins: ['http://127.0.0.1:3012', 'http://127.0.0.1:3000', 'http://localhost:3000'],
};
