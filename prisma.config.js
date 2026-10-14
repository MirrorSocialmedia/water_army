/**
 * Prisma 7 CLI configuration (施工 MD: JavaScript ESM only — no TypeScript).
 *
 * Prisma 7 removed `datasource.url` from schema.prisma: the connection URL
 * for migrate commands lives here, and the runtime client takes a driver
 * adapter (see apps/api/src/plugins/db.js). DATABASE_URL comes from the
 * process environment (compose .env / local .env) — never hardcoded.
 */
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Lazy on purpose: `prisma generate` needs no live URL; `migrate *` fails
    // with a clear error when DATABASE_URL is missing.
    url: process.env.DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
