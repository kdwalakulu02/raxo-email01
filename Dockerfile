# Stage 1: Build TypeScript source
FROM node:22.23.3-bookworm-slim AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

# Copy package descriptors and configuration
COPY package.json pnpm-lock.yaml tsconfig.json ./

# Install dependencies including devDependencies for build
RUN pnpm install --frozen-lockfile

# Copy application source
COPY src/ ./src/

# Compile TypeScript to dist/
RUN pnpm run build

# Stage 2: Minimal non-root production runner
FROM node:22.23.3-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

# Copy package descriptors and install production-only dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Copy compiled JavaScript and database migrations
COPY --from=builder /app/dist/ ./dist/
COPY migrations/ ./migrations/

# Create runtime directories with node user ownership
RUN mkdir -p /app/storage /app/config && chown -R node:node /app

# Run as non-root user
USER node

# Default port for HTTP gateway
EXPOSE 3000

# Default entrypoint: HTTP server (worker can be run by specifying `node dist/src/worker.js`)
CMD ["node", "dist/src/server.js"]
