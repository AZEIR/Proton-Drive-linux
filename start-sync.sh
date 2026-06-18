#!/bin/bash
# Proton Drive FOD (File-On-Demand) FUSE Daemon Helper Script
# Replaces start-sync.sh for the FUSE-based daemon.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="${SCRIPT_DIR}/sdk/js/cli/release/proton-fuse"
LEGACY_BINARY="${SCRIPT_DIR}/sdk/js/cli/release/proton-sync"

PIDFILE="${HOME}/.config/proton-drive-sync/daemon.pid"
LOGFILE="${HOME}/.local/state/proton-drive-cli/proton-fuse-daemon.log"
# Parse optional custom mount path from CLI argument $2
CUSTOM_PATH="$2"
if [ -n "$CUSTOM_PATH" ]; then
    MOUNT_POINT=$(realpath "$CUSTOM_PATH")
else
    MOUNT_POINT="${PROTON_MOUNT_POINT:-${HOME}/P-Drive}"
fi
PORT="${PROTON_SYNC_PORT:-8085}"

# Fall back to legacy binary if FOD binary not built yet
if [ ! -f "$BINARY" ] && [ -f "$LEGACY_BINARY" ]; then
    BINARY="$LEGACY_BINARY"
    echo "[warn] proton-fuse not found, falling back to proton-sync (full-sync mode)"
fi

mkdir -p "$(dirname "$PIDFILE")"
mkdir -p "$(dirname "$LOGFILE")"

SYNC_MODE="${PROTON_SYNC_MODE:-full}"

start_daemon() {
    cd "$SCRIPT_DIR"

    # Check PID file first
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Proton Drive daemon is already running (PID: $PID)."
            exit 0
        fi
    fi

    # Guard against a second instance started alongside a systemd-managed one
    if systemctl --user is-active --quiet proton-sync.service 2>/dev/null; then
        echo "Proton Drive is already running as a systemd service."
        echo "Use 'systemctl --user stop proton-sync.service' to stop it first."
        exit 1
    fi

    # Guard against port conflict (another process already bound to the dashboard port)
    if ss -tlnp 2>/dev/null | grep -q ":${PORT} " || \
       lsof -ti:"${PORT}" >/dev/null 2>&1; then
        echo "WARNING: Port ${PORT} is already in use — another instance may be running."
        echo "Run './drive.sh status' to investigate."
        exit 1
    fi

    # Clean up stale mount points before mkdir -p (since mkdir -p on a stale mount will fail/hang)
    if [ "$SYNC_MODE" != "full" ]; then
        if mountpoint -q "$MOUNT_POINT" 2>/dev/null || { [ -d "$MOUNT_POINT" ] && ! ls "$MOUNT_POINT" >/dev/null 2>&1; }; then
            echo "Detected stale FUSE mount at ${MOUNT_POINT}. Cleaning up..."
            fusermount3 -u "$MOUNT_POINT" 2>/dev/null || fusermount -u "$MOUNT_POINT" 2>/dev/null || true
        fi
    fi

    # Warn if the sync folder already contains files — avoids silently merging
    # existing local content with remote on a fresh setup.
    if [ -d "$MOUNT_POINT" ] && [ -n "$(ls -A "$MOUNT_POINT" 2>/dev/null)" ]; then
        echo "WARNING: Sync folder '${MOUNT_POINT}' is not empty."
        echo "  Existing local files will be merged/synced with your Proton Drive."
        printf "  Continue? [y/N]: "
        read -r _confirm
        case "$_confirm" in
            [yY]|[yY][eE][sS]) ;;
            *) echo "Aborted."; exit 0 ;;
        esac
    fi

    mkdir -p "$MOUNT_POINT"

    if [ ! -f "$BINARY" ]; then
        echo "ERROR: Binary not found at ${BINARY}"
        echo "Build it first with:"
        echo "  cd sdk/js/cli && bun run build:fuse"
        exit 1
    fi

    if [ "$SYNC_MODE" = "full" ]; then
        echo "Starting Proton Drive Full Sync daemon..."
        echo "  Local Path  : ${MOUNT_POINT}"
    else
        echo "Starting Proton Drive FOD daemon..."
        echo "  Mount point : ${MOUNT_POINT}"
    fi
    echo "  Dashboard   : http://localhost:${PORT}"
    echo "  Log file    : ${LOGFILE}"

    NODE_BIN=$(command -v node || echo "node")

    PROTON_MOUNT_POINT="$MOUNT_POINT" PROTON_SYNC_PORT="$PORT" PROTON_SYNC_MODE="$SYNC_MODE" \
        setsid "$NODE_BIN" "$BINARY" --mount-point "$MOUNT_POINT" --port "$PORT" \
        < /dev/null > "$LOGFILE" 2>&1 &

    PID=$!
    sleep 1.5
    if ps -p "$PID" > /dev/null 2>&1; then
        disown $PID
        echo "$PID" > "$PIDFILE"
        echo "Daemon started with PID $PID."
    else
        echo "ERROR: Daemon failed to start. Output of log file ($LOGFILE):"
        cat "$LOGFILE"
        rm -f "$PIDFILE"
        exit 1
    fi
}

stop_daemon() {
    local stopped=0

    # Stop PID-file-managed daemon (started via drive.sh / start-sync.sh)
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Stopping Proton Drive daemon (PID: $PID)..."
            kill "$PID"
            sleep 1

            # Unmount FUSE if still mounted
            if mountpoint -q "$MOUNT_POINT" 2>/dev/null || { [ -d "$MOUNT_POINT" ] && ! ls "$MOUNT_POINT" >/dev/null 2>&1; }; then
                echo "Unmounting FUSE filesystem at ${MOUNT_POINT}..."
                fusermount3 -u "$MOUNT_POINT" 2>/dev/null || fusermount -u "$MOUNT_POINT" 2>/dev/null || true
            fi

            rm -f "$PIDFILE"
            echo "Daemon stopped."
            stopped=1
        else
            echo "Stale PID file removed."
            rm -f "$PIDFILE"
        fi
    fi

    # Stop systemd-managed daemon as fallback
    if systemctl --user is-active --quiet proton-sync.service 2>/dev/null; then
        echo "Stopping proton-sync.service (systemd)..."
        systemctl --user stop proton-sync.service
        echo "Daemon stopped."
        stopped=1
    fi

    [ "$stopped" -eq 0 ] && echo "Proton Drive daemon is not running."
}

_print_pid_status() {
    local PID="$1"
    echo "Proton Drive daemon is RUNNING (PID: $PID)"
    if tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -q "^PROTON_SYNC_MODE=full"; then
        echo "  Mode        : Full Sync"
        echo "  Local Path  : ${MOUNT_POINT}"
    else
        echo "  Mode        : File-On-Demand (FUSE)"
        echo "  Mount point : ${MOUNT_POINT}"
        if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
            echo "  FUSE mount  : Active ✓"
        else
            echo "  FUSE mount  : Not mounted ✗"
        fi
    fi
    echo "  Dashboard   : http://localhost:${PORT}"
}

status_daemon() {
    # 1. Check PID file (daemon started via drive.sh / start-sync.sh)
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            _print_pid_status "$PID"
            exit 0
        fi
    fi

    # 2. Check systemd user service as fallback (daemon started via systemctl)
    if systemctl --user is-active --quiet proton-sync.service 2>/dev/null; then
        SYSTEMD_PID=$(systemctl --user show -p MainPID --value proton-sync.service 2>/dev/null || echo "")
        echo "Proton Drive daemon is RUNNING (systemd)"
        [ -n "$SYSTEMD_PID" ] && echo "  PID         : ${SYSTEMD_PID}"
        echo "  Managed by  : systemctl --user"
        SSTATE=$(systemctl --user show -p SubState --value proton-sync.service 2>/dev/null || echo "running")
        echo "  State       : ${SSTATE}"
        echo "  Dashboard   : http://localhost:${PORT}"
        echo ""
        echo "  Logs  : journalctl --user -u proton-sync.service -f"
        echo "  Stop  : systemctl --user stop proton-sync.service"
        exit 0
    fi

    echo "Proton Drive daemon is STOPPED."
}

case "$1" in
    start)
        start_daemon
        ;;
    stop)
        stop_daemon
        ;;
    status)
        status_daemon
        ;;
    restart)
        stop_daemon
        sleep 1
        start_daemon
        ;;
    *)
        echo "Usage: $0 {start|stop|status|restart}"
        ;;
esac
