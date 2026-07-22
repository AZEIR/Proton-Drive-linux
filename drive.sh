#!/bin/bash
# Proton Drive Linux — Management Script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="proton-sync.service"
SYNC_DB="${HOME}/.config/proton-drive/sync.db"

show_help() {
    echo "============================================="
    echo "    Proton Drive Linux Client               "
    echo "============================================="
    echo "Usage: $0 [command] [options]"
    echo ""
    echo "Daemon Commands:"
    echo "  start [path]      - Start the sync daemon (default: ~/P-Drive or custom path)"
    echo "  stop              - Stop the sync daemon"
    echo "  restart [path]    - Restart the daemon with optional custom path"
    echo "  status            - Check daemon status & view dashboard link"
    echo ""
    echo "Client & Maintenance Commands:"
    echo "  login             - Authenticate with Proton Drive"
    echo "  logs              - View real-time daemon logs"
    echo "  ui                - Open Web Dashboard in browser (http://localhost:8085)"
    echo "  reset             - Clear local sync database (forces full re-sync)"
    echo "  test              - Run automated unit & integration test suite"
    echo "============================================="
}

cmd="${1:-help}"

case "$cmd" in
    start)
        CUSTOM_PATH="$2"
        if [ -n "$CUSTOM_PATH" ]; then
            export PROTON_MOUNT_POINT="$(realpath "$CUSTOM_PATH")"
            echo "Setting sync folder to: ${PROTON_MOUNT_POINT}"
        fi
        echo "Starting sync daemon service..."
        systemctl --user start "$SERVICE_NAME"
        echo "Daemon status:"
        systemctl --user status "$SERVICE_NAME" --no-pager
        ;;
    stop)
        echo "Stopping sync daemon service..."
        systemctl --user stop "$SERVICE_NAME"
        ;;
    restart)
        CUSTOM_PATH="$2"
        if [ -n "$CUSTOM_PATH" ]; then
            export PROTON_MOUNT_POINT="$(realpath "$CUSTOM_PATH")"
            echo "Setting sync folder to: ${PROTON_MOUNT_POINT}"
        fi
        echo "Restarting sync daemon service..."
        systemctl --user restart "$SERVICE_NAME"
        ;;
    status)
        systemctl --user status "$SERVICE_NAME" --no-pager
        echo ""
        echo "Web Dashboard: http://localhost:8085"
        ;;
    logs)
        echo "Streaming live logs from systemd (Ctrl+C to exit)..."
        journalctl --user -u "$SERVICE_NAME" -f --no-hostname -o short-iso
        ;;
    ui|dashboard)
        PORT="${PORT:-8085}"
        echo "Opening Web Dashboard at http://localhost:${PORT}..."
        if command -v xdg-open >/dev/null; then
            xdg-open "http://localhost:${PORT}" 2>/dev/null
        elif command -v open >/dev/null; then
            open "http://localhost:${PORT}"
        else
            echo "Please open http://localhost:${PORT} in your browser."
        fi
        ;;
    login)
        echo "Opening authentication..."
        xdg-open "http://localhost:8085" 2>/dev/null || echo "Open http://localhost:8085 to sign in"
        ;;
    reset)
        echo "Stopping daemon..."
        systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
        echo "Clearing local sync database at ${SYNC_DB}..."
        rm -f "$SYNC_DB"
        rm -f "${SYNC_DB}-wal" "${SYNC_DB}-shm"
        echo "Done. Restart sync daemon with: ./drive.sh start"
        ;;
    show_help
    exit 0
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
