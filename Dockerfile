# syntax=docker/dockerfile:1.7
# Imagens fixadas por digest (atualize de forma deliberada; ver docs/deployment.md)
ARG NODE_IMAGE=node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
ARG CADDY_IMAGE=caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f

# ---------- dependências de produção (api + worker) ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @ipl/api --workspace @ipl/worker --include-workspace-root=false \
    && npm cache clean --force

# ---------- API ----------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY apps/api ./apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "apps/api/src/main.ts"]

# ---------- Worker ----------
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
USER node
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "apps/worker/src/cli/healthcheck.ts"]
CMD ["node", "apps/worker/src/main.ts"]

# ---------- build do frontend ----------
FROM ${NODE_IMAGE} AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @ipl/web --include-workspace-root=false
COPY apps/web ./apps/web
RUN npm run build -w @ipl/web

# ---------- Web (estático) ----------
FROM ${CADDY_IMAGE} AS web
COPY infra/caddy/Caddyfile.web /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
