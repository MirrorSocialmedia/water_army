/**
 * Database plugin — Prisma 7 via driver adapter (@prisma/adapter-pg).
 * Prisma 7 removed schema-level datasource URLs: the CLI reads
 * prisma.config.js, and the runtime client takes the adapter explicitly.
 * Dynamic imports keep unit tests free of the (native-ish) client when a
 * fake `db` is injected.
 */
/**
 * @param {{databaseUrl:string, nodeEnv:string}} config
 */
export async function createDb(config) {
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const adapter = new PrismaPg({ connectionString: config.databaseUrl });
  const prisma = new PrismaClient({
    adapter,
    log: config.nodeEnv === 'production' ? [] : ['error', 'warn'],
  });
  await prisma.$connect();
  return prisma;
}

/** @param {any} db */
export async function closeDb(db) {
  try {
    await db?.$disconnect();
  } catch {
    /* best effort */
  }
}
