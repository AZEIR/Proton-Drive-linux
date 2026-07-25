#!/bin/bash
# Proton Drive Linux — Management Script (no systemd)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_BIN="${SCRIPT_DIR}/release/proton-sync"
TRAY_SCRIPT="${SCRIPT_DIR}/proton-drive-tray.py"
TRAY_SERVICE_NAME="proton-drive-tray.service"
SYNC_DB="${HOME}/.config/proton-drive/sync.db"

show_help() {
    echo "============================================="
    echo "    Proton Drive Linux Client (no systemd)   "
    echo "============================================="
    echo "Usage: $0 [command] [options]"
    echo ""
    echo "Daemon Commands:"
    echo "  start [path]      - Start the sync daemon (default: ~/P-Drive or custom path)"
    echo "  stop              - Stop the sync daemon and tray"
    echo "  restart [path]    - Restart the daemon with optional custom path"
    echo "  status            - Check daemon & tray status & view dashboard link"
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
    PROFILE="${2:-default}"
    if [ -n "$CUSTOM_PATH" ]; then
        RESOLVED_PATH="$(eval echo "$CUSTOM_PATH")"
        fusermount -u "$RESOLVED_PATH" 2>/dev/null || umount -l "$RESOLVED_PATH" 2>/dev/null || true
        TARGET_DIR="$(mkdir -p "$RESOLVED_PATH" && cd "$RESOLVED_PATH" && pwd)"
        export PROTON_MOUNT_POINT="$TARGET_DIR"
        echo "Setting sync folder to: ${TARGET_DIR}"
    else
        TARGET_DIR="${HOME}/P-Drive"
        mkdir -p "$TARGET_DIR"
        export PROTON_MOUNT_POINT="$TARGET_DIR"
    fi
    echo "Starting Proton Drive daemon (profile: ${PROFILE})..."
    mkdir -p "${HOME}/.config/proton-drive-sync"
    nohup env PROTON_SYNC_PROFILE="$PROFILE" PROTON_MOUNT_POINT="$TARGET_DIR" "${DAEMON_BIN}" > "${HOME}/.config/proton-drive-sync/daemon.log" 2>&1 &
    
    if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
        if [ -f "$TRAY_SCRIPT" ]; then
            echo "Starting system tray..."
            nohup python3 "$TRAY_SCRIPT" > "${HOME}/.config/proton-drive-sync/tray.log" 2>&1 &
        fi
    fi
}

stop_daemon() {
    echo "Stopping Proton Drive daemon and tray..."
    pkill -f "proton-sync" 2>/dev/null || true
    pkill -f "proton-fuse" 2>/dev/null || true
    pkill -f "proton-drive-tray.py" 2>/dev/null || true
    systemctl --user stop proton-sync.service 2>/dev/null || true
    systemctl --user stop proton-drive-tray.service 2>/dev/null || true
    echo "Stopped."
}

cmd="${1:-help}"
case "$cmd" in
    start)
        start_daemon "$2"
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        start_daemon "$2"
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
    uninstall-tray)
        echo "Uninstalling system tray service..."
        systemctl --user stop "$TRAY_SERVICE_NAME" 2>/dev/null || true
        systemctl --user disable "$TRAY_SERVICE_NAME" 2>/dev/null || true
        rm -f "${HOME}/.config/systemd/user/${TRAY_SERVICE_NAME}"
        systemctl --user daemon-reload
        echo "System tray service uninstalled."
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
