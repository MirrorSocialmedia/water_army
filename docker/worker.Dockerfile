# syntax=docker/dockerfile:1
# =============================================================================
# water_army worker — BullMQ worker + task engine + scheduler reconciler.
# Hard boundary: NO Docker socket, NO host shell (MD §4 / threat model T1).
# Tool execution goes over HTTP to the API (service token); task history in
# PostgreSQL (source of truth). Prisma client is generated at build time.
# =============================================================================
FROM node:24
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --omit=dev --no-audit --no-fund
COPY prisma ./prisma
COPY prisma.config.js ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN npx prisma generate \
 && node --check apps/worker/src/worker.js \
 && node --check apps/worker/src/task-engine.js \
 && node --check apps/worker/src/tool-helpers.js \
 && node --check apps/worker/src/provider-resolver.js
USER node
EXPOSE 3001
CMD ["node", "apps/worker/src/worker.js"]
