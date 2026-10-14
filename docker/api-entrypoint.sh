#!/bin/sh
# api entrypoint: apply versioned migrations, then boot the server.
# Migrations are committed (prisma/migrations) — never auto-reset the DB here.
set -e
echo "[entrypoint] applying database migrations (prisma migrate deploy)..."
npx prisma migrate deploy
echo "[entrypoint] migrations complete — starting api"
exec node apps/api/src/server.js
