#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# on-startup.sh — runs every time the sandbox starts.
#
# Edit this file to install dependencies, clone repos, configure tools, etc.
# This file lives in /workspace and persists across container restarts.
#
# ── Examples ──────────────────────────────────────────────────────────────────
#
#   # System packages (requires sudo)
#   sudo apt-get install -y ffmpeg
#
#   # Python packages
#   pip install pandas matplotlib seaborn
#
#   # Node packages
#   npm install -g typescript ts-node
#
#   # Clone a repo into workspace
#   [ -d ~/workspace/my-project ] || git clone https://github.com/you/my-project ~/workspace/my-project
#
#   # Set environment variables (also add to ~/.bashrc for persistence)
#   export MY_API_KEY="..."
#
# ─────────────────────────────────────────────────────────────────────────────

echo "[on-startup] Nothing to do. Edit /workspace/on-startup.sh to add setup steps."
