# agent-sandbox — Dockerfile
# A lightweight developer sandbox: VSCode + Terminal + Chromium (VNC) + agent-browser
#
# Build:  docker build -t agent-sandbox .
# Run:    docker compose up

# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS builder

ARG CODE_SERVER_VERSION=4.104.0
ARG NOVNC_VERSION=1.5.0
ARG WEBSOCKIFY_VERSION=0.12.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Download code-server (architecture-aware)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${ARCH}.deb" \
    -o /tmp/code-server.deb

# Clone noVNC and websockify
RUN git clone --depth=1 --branch v${NOVNC_VERSION} \
    https://github.com/novnc/noVNC.git /opt/novnc && \
    git clone --depth=1 --branch v${WEBSOCKIFY_VERSION} \
    https://github.com/novnc/websockify.git /opt/novnc/utils/websockify

# ─── Stage 2: final ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="agent-sandbox"
LABEL org.opencontainers.image.description="Lightweight developer sandbox: VSCode + Chromium + agent-browser (Debian Bookworm)"
LABEL org.opencontainers.image.source="https://github.com/mafshin/agent-sandbox"
LABEL devcontainer.metadata='[{"remoteUser":"agent","workspaceFolder":"/workspace","postAttachCommand":"code /workspace"}]'

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV WORKSPACE=/workspace
ENV HOME=/home/agent

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Display & VNC
    xvfb \
    x11vnc \
    # Browser
    chromium \
    # Process manager & web server
    supervisor \
    nginx \
    # Python runtime
    python3 \
    python3-pip \
    python3-setuptools \
    # noVNC deps
    python3-numpy \
    # Utilities
    curl \
    ca-certificates \
    git \
    wget \
    unzip \
    jq \
    sudo \
    gosu \
    locales \
    tzdata \
    x11-utils \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 (official tarball — no apt, works on amd64 + arm64) ───────────
ARG NODE_VERSION=22.14.0
RUN ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') && \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1 \
    --exclude="*/CHANGELOG.md" --exclude="*/LICENSE" --exclude="*/README.md"

# ── agent-browser CLI ─────────────────────────────────────────────────────────
RUN npm install -g agent-browser@latest

# ── ttyd (web terminal) ───────────────────────────────────────────────────────
RUN ARCH=$(uname -m) && \
    TTYD_ARCH=$([ "$ARCH" = "aarch64" ] && echo "aarch64" || echo "x86_64") && \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" \
    -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd

# ── code-server ───────────────────────────────────────────────────────────────
COPY --from=builder /tmp/code-server.deb /tmp/code-server.deb
RUN dpkg -i /tmp/code-server.deb && rm /tmp/code-server.deb

# ── noVNC + websockify ────────────────────────────────────────────────────────
COPY --from=builder /opt/novnc /opt/novnc
RUN pip3 install --no-cache-dir --break-system-packages websockify

# ── Create agent user ─────────────────────────────────────────────────────────
RUN useradd -m -s /bin/bash -u 1000 agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/agent && \
    chmod 0440 /etc/sudoers.d/agent

# ── Chromium agent profile ────────────────────────────────────────────────────
RUN mkdir -p /home/agent/.config/chromium/agent && \
    echo '{"profile":{"name":"agent"}}' \
    > /home/agent/.config/chromium/agent/Preferences && \
    chown -R agent:agent /home/agent/.config/chromium

# ── Workspace directory ───────────────────────────────────────────────────────
RUN mkdir -p /workspace && chown agent:agent /workspace

# ── Copy configs ──────────────────────────────────────────────────────────────
COPY config/nginx.conf        /etc/nginx/nginx.conf
COPY config/supervisord.conf  /etc/supervisor/conf.d/sandbox.conf
COPY config/code-server.yaml  /home/agent/.config/code-server/config.yaml

# ── VS Code user settings (disable workspace trust dialog) ────────────────────
RUN mkdir -p /home/agent/.local/share/code-server/User
COPY config/vscode-settings.json /home/agent/.local/share/code-server/User/settings.json

# ── api-server ────────────────────────────────────────────────────────────────
COPY api-server/package.json      /opt/api-server/package.json
COPY api-server/package-lock.json /opt/api-server/package-lock.json
RUN npm ci --prefix /opt/api-server --omit=dev
COPY api-server/state.js          /opt/api-server/state.js
COPY api-server/index.js          /opt/api-server/index.js
COPY api-server/routes/           /opt/api-server/routes/

# ── Copy scripts ──────────────────────────────────────────────────────────────
COPY scripts/entrypoint.sh    /entrypoint.sh
COPY scripts/start-chrome.sh  /usr/local/bin/start-chrome.sh
COPY scripts/start-x11vnc.sh  /usr/local/bin/start-x11vnc.sh
COPY scripts/on-startup.sh    /etc/skel/on-startup.sh

RUN chmod +x /entrypoint.sh /usr/local/bin/start-chrome.sh /usr/local/bin/start-x11vnc.sh /etc/skel/on-startup.sh

# ── Copy agent-browser skill ──────────────────────────────────────────────────
COPY skills/agent-browser/SKILL.md /etc/skel/.claude/skills/agent-browser/SKILL.md

# ── Dashboard static files ────────────────────────────────────────────────────
COPY static/ /opt/sandbox/

# ── Fix ownership ─────────────────────────────────────────────────────────────
RUN chown -R agent:agent /home/agent

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
