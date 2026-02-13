# knight-light — Lightweight AI agent runtime
# Multi-stage build for minimal image size

# ---- Build stage ----
FROM node:22-slim AS build

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ---- Runtime stage ----
FROM node:22-slim

# Install Claude Agent SDK CLI dependency (bundled with the SDK)
# The SDK needs the claude binary available
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r knight && useradd -r -g knight -m -d /home/knight knight

WORKDIR /app

# Copy built app and production deps
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Create workspace mount point
RUN mkdir -p /workspace && chown knight:knight /workspace

# Default OAuth dir
RUN mkdir -p /home/knight/.claude && chown knight:knight /home/knight/.claude

USER knight

ENV NODE_ENV=production
ENV PORT=18789
ENV WORKSPACE_DIR=/workspace

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:18789/healthz || exit 1

CMD ["node", "dist/index.js"]
