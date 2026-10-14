# syntax=docker/dockerfile:1
# =============================================================================
# water_army worker — BullMQ worker + scheduler reconciler.
# Hard boundary: NO Docker socket, NO host shell (MD §4 / threat model T1).
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
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN node --check apps/worker/src/worker.js \
 && node --check apps/worker/src/scheduler-reconciler.js
USER node
EXPOSE 3001
CMD ["node", "apps/worker/src/worker.js"]
