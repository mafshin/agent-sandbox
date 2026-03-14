# agent-sandbox — Dockerfile
# A lightweight developer sandbox: VSCode + Terminal + Chromium (VNC) + agent-browser
#
# Build:  docker build -t agent-sandbox .
# Run:    docker compose up

# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS builder

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
FROM ubuntu:22.04

LABEL org.opencontainers.image.title="agent-sandbox"
LABEL org.opencontainers.image.description="Lightweight developer sandbox: VSCode + Chromium + agent-browser"
LABEL org.opencontainers.image.source="https://github.com/mafshin/agent-sandbox"

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
    chromium-browser \
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

# ── Node.js 22 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# ── agent-browser CLI ─────────────────────────────────────────────────────────
RUN npm install -g agent-browser@latest

# ── code-server ───────────────────────────────────────────────────────────────
COPY --from=builder /tmp/code-server.deb /tmp/code-server.deb
RUN dpkg -i /tmp/code-server.deb && rm /tmp/code-server.deb

# ── noVNC + websockify ────────────────────────────────────────────────────────
COPY --from=builder /opt/novnc /opt/novnc
RUN pip3 install --no-cache-dir websockify

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

# ── Copy scripts ──────────────────────────────────────────────────────────────
COPY scripts/entrypoint.sh    /entrypoint.sh
COPY scripts/start-chrome.sh  /usr/local/bin/start-chrome.sh
COPY scripts/on-startup.sh    /etc/skel/on-startup.sh

RUN chmod +x /entrypoint.sh /usr/local/bin/start-chrome.sh /etc/skel/on-startup.sh

# ── Copy agent-browser skill ──────────────────────────────────────────────────
COPY skills/agent-browser/SKILL.md /etc/skel/.claude/skills/agent-browser/SKILL.md

# ── Fix ownership ─────────────────────────────────────────────────────────────
RUN chown -R agent:agent /home/agent

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
