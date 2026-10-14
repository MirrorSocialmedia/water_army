# syntax=docker/dockerfile:1
# =============================================================================
# water_army web — React + Vite static build + zero-dependency
# static/`/api`-proxy server (same-origin API, MD §15).
# =============================================================================
FROM node:24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build --workspace=@water-army/web

# ---------------------------------------------------------------- production
FROM node:24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/web/dist ./dist
COPY apps/web/server.js ./server.js
RUN node --check server.js
USER node
EXPOSE 3012
CMD ["node", "server.js"]
