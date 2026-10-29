# syntax=docker/dockerfile:1
# =============================================================================
# water_army api — Fastify. THE ONLY service with Docker socket access (ro).
# Multi-stage: production stage carries only production deps (MD §15).
# =============================================================================
FROM node:24 AS build
WORKDIR /app
# Workspace manifests first so the dependency layer caches across source edits.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
COPY prisma.config.js ./
COPY packages ./packages
RUN npx prisma generate

# ---------------------------------------------------------------- production
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
COPY apps/api ./apps/api
# WA-FIX2B (R3): per-device canvas font variants (Roboto weights, Apache-2.0)
# staged by createDevice — tiny static assets, resolved relative to cwd (/app).
COPY images/fonts ./images/fonts
COPY docker/api-entrypoint.sh ./docker/api-entrypoint.sh
# Regenerate the client against the production install, then syntax-check.
RUN npx prisma generate \
 && node --check apps/api/src/server.js \
 && node --check apps/api/src/cli/setup-admin.js \
 && chmod +x docker/api-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["sh", "docker/api-entrypoint.sh"]
