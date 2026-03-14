#!/bin/bash
# Wait for Xvfb to be ready
until xdpyinfo -display :99 >/dev/null 2>&1; do
    sleep 0.5
done

exec chromium-browser \
    --no-sandbox \
    --disable-dev-shm-usage \
    --remote-debugging-port=9222 \
    --remote-debugging-address=0.0.0.0 \
    --user-data-dir=/home/agent/.config/chromium \
    --profile-directory=agent \
    --display=:99 \
    --window-size="${DISPLAY_WIDTH:-1280},${DISPLAY_HEIGHT:-1024}" \
    --no-first-run \
    --disable-default-apps \
    --disable-extensions \
    --disable-background-networking \
    --disable-sync \
    --disable-translate \
    --metrics-recording-only \
    about:blank
