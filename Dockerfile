# knight-agent — Lightweight AI agent runtime
# Single universal image for all knights

# ---- Build stage (TypeScript compile) ----
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --production

# ---- Tool installer (keeps runtime layer clean) ----
FROM node:22-slim AS tools

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ripgrep — required by SDK's Grep tool
RUN curl -sL https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz \
    | tar xz -C /tmp && mv /tmp/ripgrep-*/rg /usr/local/bin/rg

# nats CLI — fleet communication
RUN curl -sL https://github.com/nats-io/natscli/releases/download/v0.2.2/nats-0.2.2-linux-amd64.zip \
    -o /tmp/nats.zip && unzip /tmp/nats.zip -d /tmp/nats \
    && mv /tmp/nats/nats-0.2.2-linux-amd64/nats /usr/local/bin/nats && chmod +x /usr/local/bin/nats

# kubectl
RUN curl -sLo /usr/local/bin/kubectl \
    "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x /usr/local/bin/kubectl

# gh CLI (dynamic version)
RUN GH_VERSION=$(curl -sL https://api.github.com/repos/cli/cli/releases/latest | grep '"tag_name"' | sed 's/.*"v\(.*\)".*/\1/') \
    && curl -sL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar xz -C /tmp && mv /tmp/gh_*/bin/gh /usr/local/bin/gh

# yq
RUN curl -sLo /usr/local/bin/yq \
    "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
    && chmod +x /usr/local/bin/yq

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    jq \
    sed \
    gawk \
    grep \
    python3 \
    python3-pip \
    python3-venv \
    dnsutils \
    netcat-openbsd \
    unzip \
    file \
    less \
    tree \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tools /usr/local/bin/rg /usr/local/bin/rg
COPY --from=tools /usr/local/bin/nats /usr/local/bin/nats
COPY --from=tools /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=tools /usr/local/bin/gh /usr/local/bin/gh
COPY --from=tools /usr/local/bin/yq /usr/local/bin/yq

# Create knight user with writable home
RUN groupadd -r knight && useradd -r -g knight -m -d /home/knight -s /bin/bash knight

# Writable .claude directory for SDK session data + OAuth token refresh
RUN mkdir -p /home/knight/.claude && chown -R knight:knight /home/knight

# Knight's local bin — PVC-persistent, on PATH
RUN mkdir -p /home/knight/.local/bin && chown -R knight:knight /home/knight/.local

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

RUN mkdir -p /workspace && chown knight:knight /workspace
RUN mkdir -p /home/knight/.local/lib/python3 && chown -R knight:knight /home/knight/.local

USER knight

ENV NODE_ENV=production \
    PORT=18789 \
    WORKSPACE_DIR=/workspace \
    PATH="/home/knight/.local/bin:$PATH" \
    PYTHONUSERBASE="/home/knight/.local"

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:18789/healthz || exit 1

CMD ["node", "dist/index.js"]
