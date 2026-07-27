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

unmount_fuse_path() {
    local mount_path="$1"
    if command -v fusermount3 >/dev/null 2>&1; then
        fusermount3 -u -z "$mount_path" 2>/dev/null || umount -l "$mount_path" 2>/dev/null || true
    elif command -v fusermount >/dev/null 2>&1; then
        fusermount -u -z "$mount_path" 2>/dev/null || umount -l "$mount_path" 2>/dev/null || true
    else
        umount -l "$mount_path" 2>/dev/null || true
    fi
}

DB_FILE="${HOME}/.config/proton-drive-sync/sync_state.db"
STORED_MODE=""
STORED_FUSE=""
if [ -f "$DB_FILE" ] && command -v sqlite3 >/dev/null 2>&1; then
    STORED_MODE="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='sync_mode';" 2>/dev/null)"
    STORED_FUSE="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='fuse_mount_point';" 2>/dev/null)"
fi

cleanup() {
    [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null
    [ -n "$TRAY_PID" ] && kill "$TRAY_PID" 2>/dev/null
    unmount_fuse_path "${HOME}/P-Drive-FUSE"
    if [ -n "$STORED_FUSE" ] && [ "$STORED_FUSE" != "${HOME}/P-Drive-FUSE" ]; then
        unmount_fuse_path "$STORED_FUSE"
    fi
    wait 2>/dev/null
    exit 0
}
trap cleanup EXIT INT TERM

# Start the sync daemon in the background with environment set from DB if not provided
export PROTON_SYNC_MODE="${PROTON_SYNC_MODE:-${STORED_MODE:-full}}"
"$DAEMON_BIN" &
DAEMON_PID=$!

# Start the tray icon if a graphical display is available
start_tray() {
    if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
        if [ -f "$TRAY_SCRIPT" ]; then
            EXISTING_PID="$(pgrep -f "proton-drive-tray.py" | head -n 1)"
            if [ -n "$EXISTING_PID" ]; then
                TRAY_PID="$EXISTING_PID"
            else
                python3 "$TRAY_SCRIPT" &
                TRAY_PID=$!
            fi
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
