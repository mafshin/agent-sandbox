# agent-sandbox

A lightweight, fully open-source developer sandbox with VSCode, terminal, and a controllable browser — all in a single Docker container.

Built as a transparent, auditable alternative to proprietary sandbox images.

## What's inside

| Surface | Technology | URL |
|---------|-----------|-----|
| VSCode (editor + terminal) | [code-server](https://github.com/coder/code-server) | `http://localhost:8080/` |
| Browser (interactive via VNC) | Chromium + [noVNC](https://github.com/novnc/noVNC) | `http://localhost:8080/vnc/vnc.html?autoconnect=true` |
| Chrome DevTools Protocol | Chromium CDP | `localhost:9222` (container-internal) |

- **`agent-browser` CLI** pre-installed — Claude can drive the browser immediately
- **`agent-browser` skill** pre-loaded for Claude Code
- **Chromium profile** named `agent` set as the default profile
- Single exposed port (`8080`) — nginx routes everything internally

## Quick start

```bash
# Pull and run
docker compose up

# Or run directly
docker run -d \
  --name agent-sandbox \
  --shm-size=2gb \
  --security-opt seccomp:unconfined \
  -p 8080:8080 \
  -v agent-workspace:/workspace \
  ghcr.io/mafshin/agent-sandbox:latest
```

Open **http://localhost:8080** for VSCode.
Open **http://localhost:8080/vnc/vnc.html?autoconnect=true** for the browser view.

## Customising the sandbox

Edit `/workspace/on-startup.sh` in VSCode — it runs automatically every time the sandbox starts:

```bash
#!/bin/bash
# Install whatever you need
sudo apt-get install -y ffmpeg
pip install pandas matplotlib
npm install -g typescript
git clone https://github.com/you/your-project ~/workspace/your-project
```

The `/workspace` directory is a Docker volume — your script persists across restarts and image updates.

To run it without restarting:
```bash
bash /workspace/on-startup.sh
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Host port |
| `TZ` | `UTC` | Timezone |
| `WORKSPACE` | `/workspace` | Working directory |
| `DISPLAY_WIDTH` | `1280` | Browser/VNC width (px) |
| `DISPLAY_HEIGHT` | `1024` | Browser/VNC height (px) |

Copy `.env.example` to `.env` to override defaults.

## Using agent-browser with Claude

Chrome is already running and connected to CDP. In any Claude Code session inside the sandbox:

```bash
agent-browser connect 9222
agent-browser open https://example.com
agent-browser snapshot -i
```

The `agent-browser` skill is pre-loaded, so Claude will use it automatically when asked to browse or automate the web.

## Building locally

```bash
docker build -t agent-sandbox:dev .
docker run -d --shm-size=2gb --security-opt seccomp:unconfined -p 8080:8080 agent-sandbox:dev
```

## Architecture

```
supervisord (PID 1)
├── Xvfb          :99     Virtual display
├── Chromium      :9222   Browser (CDP) on Xvfb, profile: agent
├── x11vnc        :5900   VNC server — full keyboard + mouse input
├── websockify    :6080   WebSocket bridge for noVNC
├── code-server   :8443   VSCode
└── nginx         :8080   Reverse proxy (single public port)
```

## License

MIT
