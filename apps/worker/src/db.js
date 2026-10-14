/**
 * Worker database access — Prisma 7 via driver adapter (same pattern as the
 * api; the worker needs Postgres as the task source of truth, MD §11.2).
 * Dynamic import keeps unit tests hermetic when a fake db is injected.
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
