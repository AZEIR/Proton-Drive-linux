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

# Helper to start daemon (and tray if display available)
start_daemon() {
    CUSTOM_PATH="$1"
    if [ -n "$CUSTOM_PATH" ]; then
        export PROTON_MOUNT_POINT="$(realpath "$CUSTOM_PATH")"
        echo "Setting sync folder to: ${PROTON_MOUNT_POINT}"
    fi
    echo "Starting Proton Drive daemon via systemd..."
    systemctl --user start proton-sync.service
    # Tray is bound to daemon, it will start automatically if needed
}

stop_daemon() {
    echo "Stopping Proton Drive daemon and tray..."
    systemctl --user stop proton-sync.service
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
        echo "Daemon status:"; pgrep -fl "${DAEMON_BIN}" || echo "Not running"
        echo "Tray status:"; pgrep -fl "proton-drive-tray.py" || echo "Not running"
        echo "Web Dashboard: http://localhost:8085"
        ;;
    logs)
        echo "Tailing daemon log (Ctrl+C to exit)..."
        tail -F "${HOME}/.config/proton-drive/daemon.log"
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
        echo "Stopping daemon..."
        stop_daemon
        echo "Clearing local sync database at ${SYNC_DB}..."
        echo "Installing systemd service for system tray..."
        mkdir -p "${HOME}/.config/systemd/user"
        if [ -f "${SCRIPT_DIR}/proton-drive-tray.service.template" ]; then
            sed -e "s|{{SCRIPT_DIR}}|${SCRIPT_DIR}|g" \
                -e "s|{{DISPLAY}}|${DISPLAY:-:0}|g" \
                -e "s|{{WAYLAND_DISPLAY}}|${WAYLAND_DISPLAY:-wayland-0}|g" \
                -e "s|{{PATH}}|${PATH}|g" \
                -e "s|{{PORT}}|8085|g" \
                "${SCRIPT_DIR}/proton-drive-tray.service.template" > "${HOME}/.config/systemd/user/${TRAY_SERVICE_NAME}"
            systemctl --user daemon-reload
            systemctl --user enable "$TRAY_SERVICE_NAME"
            systemctl --user restart "$TRAY_SERVICE_NAME" || true
            echo "System tray autostart enabled."
        else
            echo "Error: proton-drive-tray.service.template not found."
        fi
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
        cd "$SCRIPT_DIR" && bun test tests/unit tests/integration
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
