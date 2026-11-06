# Staging image: same build as Raxo Email, but the runtime is Ubuntu 24.04 because the
# RaxoSentinel release binary requires glibc >= 2.39 (Debian bookworm provides 2.36).
FROM node:22.23.3-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY src/ ./src/
RUN pnpm run build

FROM node:22.23.3-bookworm-slim AS proddeps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM ubuntu:24.04 AS runner
ENV NODE_ENV=production
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
RUN userdel -r ubuntu \
 && useradd -u 1000 -m -s /usr/sbin/nologin node \
 && mkdir -p /app/storage /app/config /run/raxosentinel \
 && chown -R node:node /app
WORKDIR /app
COPY --from=proddeps --chown=node:node /app/node_modules ./node_modules
COPY --from=proddeps --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/dist/ ./dist/
COPY --chown=node:node migrations/ ./migrations/
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
