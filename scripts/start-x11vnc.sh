#!/bin/bash
# Wait for Xvfb to be ready before starting x11vnc
until xdpyinfo -display :99 >/dev/null 2>&1; do
    sleep 0.5
done
sleep 2

exec x11vnc -display :99 -nopw -forever -shared -port 5900
