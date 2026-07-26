#!/bin/bash
# Proton Drive Linux — Management Script (no systemd)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_BIN="${SCRIPT_DIR}/release/proton-sync"
TRAY_SCRIPT="${SCRIPT_DIR}/proton-drive-tray.py"

show_help() {
    echo "============================================="
    echo "    Proton Drive Linux Client (no systemd)   "
    echo "============================================="
    echo "Usage: $0 [command] [options]"
    echo ""
    echo "Daemon Commands:"
    echo "  start [path] [--mode=full|fuse] - Start daemon in Full Sync or FUSE Mode"
    echo "  mode [full|fuse]                - Switch sync mode on the fly"
    echo "  stop                            - Stop the sync daemon, tray, & unmount FUSE"
    echo "  restart [path]                  - Restart the daemon with optional custom path"
    echo "  status                          - Check daemon, mode, tray status & view dashboard"
    echo ""
    echo "Client & Maintenance Commands:"
    echo "  login             - Authenticate with Proton Drive"
    echo "  logs              - View real-time daemon logs (tail -f)"
    echo "  ui                - Open Web Dashboard in browser (http://localhost:8085)"
    echo "  reset             - Clear local sync database (forces full re-sync)"
    echo "  test              - Run automated unit & integration test suite"
    echo "============================================="
}

# Helper to start daemon
start_daemon() {
    CUSTOM_PATH="$1"
    DB_FILE="${HOME}/.config/proton-drive-sync/sync_state.db"
    STORED_MODE=""
    if [ -f "$DB_FILE" ] && command -v sqlite3 >/dev/null 2>&1; then
        STORED_MODE="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='sync_mode';" 2>/dev/null)"
    fi

    SYNC_MODE="full"
    if [ "$2" = "--mode=fuse" ] || [ "$3" = "--mode=fuse" ] || [ "$1" = "--mode=fuse" ]; then
        SYNC_MODE="fuse"
    elif [ "$2" = "--mode=full" ] || [ "$3" = "--mode=full" ] || [ "$1" = "--mode=full" ]; then
        SYNC_MODE="full"
    elif [ "$STORED_MODE" = "fuse" ]; then
        SYNC_MODE="fuse"
    fi

    if [ -n "$CUSTOM_PATH" ] && [ "$CUSTOM_PATH" != "--mode=fuse" ] && [ "$CUSTOM_PATH" != "--mode=full" ]; then
        RESOLVED_PATH="$(eval echo "$CUSTOM_PATH")"
        fusermount -u -z "$RESOLVED_PATH" 2>/dev/null || umount -l "$RESOLVED_PATH" 2>/dev/null || true
        TARGET_DIR="$(mkdir -p "$RESOLVED_PATH" && cd "$RESOLVED_PATH" && pwd)"
        export PROTON_MOUNT_POINT="$TARGET_DIR"
        echo "Setting sync folder to: ${TARGET_DIR}"
    else
        if [ "$SYNC_MODE" = "fuse" ]; then
            TARGET_DIR="${HOME}/P-Drive-FUSE"
        else
            TARGET_DIR="${HOME}/P-Drive"
        fi
        fusermount -u -z "$TARGET_DIR" 2>/dev/null || umount -l "$TARGET_DIR" 2>/dev/null || true
        mkdir -p "$TARGET_DIR"
        export PROTON_MOUNT_POINT="$TARGET_DIR"
    fi

    echo "Starting Proton Drive daemon in ${SYNC_MODE^^} mode..."
    mkdir -p "${HOME}/.config/proton-drive-sync"
    nohup env PROTON_SYNC_MODE="$SYNC_MODE" PROTON_MOUNT_POINT="$TARGET_DIR" "${DAEMON_BIN}" > "${HOME}/.config/proton-drive-sync/daemon.log" 2>&1 &
    
    if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
        if [ -f "$TRAY_SCRIPT" ]; then
            if ! pgrep -f "proton-drive-tray.py" >/dev/null 2>&1; then
                echo "Starting system tray..."
                nohup python3 "$TRAY_SCRIPT" > "${HOME}/.config/proton-drive-sync/tray.log" 2>&1 &
            fi
        fi
    fi
}

stop_daemon() {
    echo "Stopping Proton Drive daemon, unmounting FUSE, and stopping tray..."
    pkill -f "proton-sync" 2>/dev/null || true
    pkill -f "proton-drive-tray.py" 2>/dev/null || true
    fusermount -u -z "${HOME}/P-Drive-FUSE" 2>/dev/null || umount -l "${HOME}/P-Drive-FUSE" 2>/dev/null || true
    echo "Stopped."
}

cmd="${1:-help}"
case "$cmd" in
    start)
        start_daemon "$2" "$3"
        ;;
    mode)
        TARGET_MODE="${2:-full}"
        echo "Switching Proton Drive sync mode to ${TARGET_MODE^^}..."
        stop_daemon
        start_daemon "" "--mode=${TARGET_MODE}"
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        start_daemon "$2" "$3"
        ;;
    status)
        echo "Daemon status:"; pgrep -fl "proton-sync" || echo "Not running"
        echo "Tray status:"; pgrep -fl "proton-drive-tray.py" || echo "Not running"
        echo "Web Dashboard: http://localhost:8085"
        ;;
    logs)
        LOG_FILE="${HOME}/.local/state/proton-drive-cli/proton-drive.log"
        DAEMON_LOG="${HOME}/.config/proton-drive-sync/daemon.log"
        echo "Tailing daemon logs (Ctrl+C to exit)..."
        if [ -f "$LOG_FILE" ] && [ -f "$DAEMON_LOG" ]; then
            tail -F "$DAEMON_LOG" "$LOG_FILE"
        elif [ -f "$LOG_FILE" ]; then
            tail -F "$LOG_FILE"
        else
            mkdir -p "${HOME}/.config/proton-drive-sync"
            touch "$DAEMON_LOG"
            tail -F "$DAEMON_LOG"
        fi
        ;;
    ui|dashboard)
        PORT=8085
        echo "Opening Web Dashboard at http://localhost:${PORT}..."
        if command -v xdg-open > /dev/null; then
            xdg-open "http://localhost:${PORT}" 2>/dev/null
        elif command -v open > /dev/null; then
            open "http://localhost:${PORT}"
        else
            echo "Please open http://localhost:${PORT} in your browser."
        fi
        ;;
    login)
        echo "Opening authentication page..."
        xdg-open "http://localhost:8085" 2>/dev/null || echo "Open http://localhost:8085 to sign in"
        ;;
    reset)
        echo "Stopping daemon and tray..."
        stop_daemon
        echo "Clearing local sync databases, state, and caches..."
        rm -rf "${HOME}/.config/proton-drive-sync"*
        rm -rf "${HOME}/.config/proton-drive"*
        rm -rf "${HOME}/.local/share/proton-drive-cli"*
        rm -rf "${HOME}/.local/state/proton-drive-cli"*
        rm -rf "${HOME}/.cache/proton-drive-cli"*
        echo "Local sync state completely cleared."
        echo "Reset complete. Start daemon with: ./drive.sh start [path]"
        ;;
    test)
        echo "Running automated test suite..."
        cd "$SCRIPT_DIR" && bun test tests/
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo "Unknown command: $cmd"
        echo ""
        show_help
        exit 1
        ;;
esac
