/**
 * API entrypoint — validates config, builds the app, listens, graceful shutdown.
 */
import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  const app = await buildApp({ config });

  await app.listen({ port: config.port, host: config.host });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'api shutting down (graceful, 30s compose stop grace)');
    app
      .close()
      .catch((err) => app.log.error({ error: err.message }, 'error during close'))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Config errors must be loud and unambiguous (no half-started server).
  // eslint-disable-next-line no-console
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
