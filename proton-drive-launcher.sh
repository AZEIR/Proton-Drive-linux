#!/bin/bash
# Proton Drive Linux — Unified Launcher
# Starts the sync daemon and the system tray together as one application.
# - Stopping the service (systemctl stop) kills both daemon and tray.
# - Tray "Quit" menu calls systemctl stop, which stops everything.
# - If the tray crashes, it is restarted automatically.
# - If the daemon exits, the tray is killed and systemd handles restart.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_BIN="${SCRIPT_DIR}/release/proton-sync"
TRAY_SCRIPT="${SCRIPT_DIR}/proton-drive-tray.py"

DAEMON_PID=""
TRAY_PID=""

cleanup() {
    [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null
    [ -n "$TRAY_PID" ] && kill "$TRAY_PID" 2>/dev/null
    wait 2>/dev/null
    exit 0
}
trap cleanup EXIT INT TERM

# Start the sync daemon in the background
"$DAEMON_BIN" &
DAEMON_PID=$!

# Start the tray icon if a graphical display is available
start_tray() {
    if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
        if [ -f "$TRAY_SCRIPT" ]; then
            python3 "$TRAY_SCRIPT" &
            TRAY_PID=$!
        fi
    fi
}

sleep 1  # Let the daemon's dashboard come up first
start_tray

# Monitor loop: keep both alive together
while true; do
    # If the daemon died, exit (systemd Restart=always will restart everything)
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
        break
    fi

    # If the tray died unexpectedly, restart it
    if [ -n "$TRAY_PID" ] && ! kill -0 "$TRAY_PID" 2>/dev/null; then
        sleep 2
        # Double-check the daemon is still alive before restarting tray
        if kill -0 "$DAEMON_PID" 2>/dev/null; then
            start_tray
        else
            break
        fi
    fi

    sleep 2
done

cleanup
