#!/bin/bash
# Proton Drive FOD (File-On-Demand) FUSE Daemon Helper Script
# Replaces start-sync.sh for the FUSE-based daemon.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="${SCRIPT_DIR}/sdk/js/cli/release/proton-fuse"
LEGACY_BINARY="${SCRIPT_DIR}/sdk/js/cli/release/proton-sync"

PIDFILE="${HOME}/.config/proton-drive-sync/daemon.pid"
LOGFILE="${HOME}/.local/state/proton-drive-cli/proton-fuse-daemon.log"
MOUNT_POINT="${PROTON_MOUNT_POINT:-${HOME}/P-Drive}"
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

    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Proton Drive daemon is already running (PID: $PID)."
            exit 0
        fi
    fi

    # Clean up stale mount points before mkdir -p (since mkdir -p on a stale mount will fail/hang)
    if [ "$SYNC_MODE" != "full" ]; then
        if mountpoint -q "$MOUNT_POINT" 2>/dev/null || { [ -d "$MOUNT_POINT" ] && ! ls "$MOUNT_POINT" >/dev/null 2>&1; }; then
            echo "Detected stale FUSE mount at ${MOUNT_POINT}. Cleaning up..."
            fusermount3 -u "$MOUNT_POINT" 2>/dev/null || fusermount -u "$MOUNT_POINT" 2>/dev/null || true
        fi
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
        else
            echo "Proton Drive daemon is not running (stale PID file removed)."
            rm -f "$PIDFILE"
        fi
    else
        echo "Proton Drive daemon is not running."
    fi
}

status_daemon() {
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if ps -p "$PID" > /dev/null 2>&1; then
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
            exit 0
        fi
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
