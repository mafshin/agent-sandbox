#!/bin/bash
set -e

# ── Defaults ──────────────────────────────────────────────────────────────────
export DISPLAY_WIDTH="${DISPLAY_WIDTH:-1280}"
export DISPLAY_HEIGHT="${DISPLAY_HEIGHT:-1024}"
export WORKSPACE="${WORKSPACE:-/workspace}"
export TZ="${TZ:-UTC}"

# ── Timezone ──────────────────────────────────────────────────────────────────
if [ -f "/usr/share/zoneinfo/${TZ}" ]; then
    ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime
    echo "${TZ}" > /etc/timezone
fi

# ── Ensure workspace exists and is owned by agent ─────────────────────────────
mkdir -p "${WORKSPACE}"
chown agent:agent "${WORKSPACE}"

# ── Install agent-browser skill on first run ──────────────────────────────────
SKILL_DST="/home/agent/.claude/skills/agent-browser/SKILL.md"
if [ ! -f "${SKILL_DST}" ]; then
    gosu agent npx -y skills add vercel-labs/agent-browser --skill agent-browser
fi

# ── Seed on-startup.sh on first run ───────────────────────────────────────────
STARTUP_SCRIPT="${WORKSPACE}/on-startup.sh"
if [ ! -f "${STARTUP_SCRIPT}" ]; then
    cp /etc/skel/on-startup.sh "${STARTUP_SCRIPT}"
    chmod +x "${STARTUP_SCRIPT}"
    chown agent:agent "${STARTUP_SCRIPT}"
fi

# ── Ensure log dirs exist ─────────────────────────────────────────────────────
mkdir -p /var/log/supervisor /var/log/nginx
chown -R agent:agent /var/log/supervisor

# ── Run user startup hook (as agent user) ─────────────────────────────────────
echo "[sandbox] Running ${STARTUP_SCRIPT} ..."
gosu agent bash "${STARTUP_SCRIPT}" 2>&1 | tee /tmp/on-startup.log || true
echo "[sandbox] on-startup.sh complete."

# ── Print access URLs ─────────────────────────────────────────────────────────
PORT="${PORT:-8080}"
CYAN='\033[36m'; YELLOW='\033[33m'; GREEN='\033[32m'; BOLD='\033[1m'; RESET='\033[0m'
printf "${CYAN}${BOLD}"
cat << 'BANNER'

                          _                         _ _
  __ _  __ _  ___ _ __ | |_      ___  __ _ _ __   __| | |__   _____  __
 / _` |/ _` |/ _ \ '_ \| __|    / __|/ _` | '_ \ / _` | '_ \ / _ \ \/ /
| (_| | (_| |  __/ | | | |_     \__ \ (_| | | | | (_| | |_) | (_) >  <
 \__,_|\__, |\___|_| |_|\__|    |___/\__,_|_| |_|\__,_|_.__/ \___/_/\_\
        |___/

BANNER
printf "${RESET}"
printf "  ${YELLOW}Dashboard${RESET}  →  ${GREEN}http://localhost:${PORT}${RESET}\n"
printf "  ${YELLOW}VSCode${RESET}     →  ${GREEN}http://localhost:${PORT}/editor/${RESET}\n"
printf "  ${YELLOW}Browser${RESET}    →  ${GREEN}http://localhost:${PORT}/vnc/vnc.html?autoconnect=true${RESET}\n"
printf "  ${YELLOW}Terminal${RESET}   →  ${GREEN}http://localhost:${PORT}/terminal/${RESET}\n"
printf "  ${YELLOW}API${RESET}        →  ${GREEN}http://localhost:${PORT}/sandbox-api/docs${RESET}\n"
printf "\n"
printf "  Services are starting — logs follow:\n"
printf "\n"

# ── Hand off to supervisord ───────────────────────────────────────────────────
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/sandbox.conf
