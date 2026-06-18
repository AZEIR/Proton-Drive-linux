#!/bin/bash
# Unified Proton Drive CLI Wrapper — FOD (File-On-Demand) Mode

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/start-sync.sh"
CLI_BINARY="${SCRIPT_DIR}/proton-drive"
MOUNT_POINT="${PROTON_MOUNT_POINT:-${HOME}/P-Drive}"

show_help() {
    echo "============================================="
    echo "    Proton Drive Linux Client (Full Sync)    "
    echo "============================================="
    echo "Usage: $0 [command] [custom-path]"
    echo ""
    echo "Daemon Commands:"
    echo "  start [path]      - Start the sync daemon (Full Sync to ~/P-Drive or custom path)"
    echo "  stop              - Stop the daemon"
    echo "  restart [path]    - Restart the daemon with optional custom path"
    echo "  status            - Check daemon status & view dashboard link"
    echo ""
    echo "Tray Icon Commands:"
    echo "  tray              - Start the system tray icon in background"
    echo "  stop-tray         - Stop the system tray icon"
    echo "  install-tray      - Enable tray icon autostart on desktop login"
    echo "  uninstall-tray    - Disable tray icon autostart on desktop login"
    echo ""
    echo "File Commands:"
    echo "  login             - Authenticate your Proton account"
    echo "  logs              - View real-time daemon logs"
    echo "  ui                - Open the Web Dashboard in your browser"
    echo "  mount             - Show current mount point"
    echo "  reset             - Clear local sync database & cache"
    echo "  sync-once [path]  - Run a single complete synchronization pass and exit"
    echo ""
    echo "File-On-Demand (FUSE) Mode:"
    echo "  PROTON_SYNC_MODE=fod ./drive.sh start [path]"
    echo "============================================="
}

case "$1" in
    login)
        echo "Launching Proton Drive authentication..."
        "$CLI_BINARY" auth login
        ;;
    start)
        "$SYNC_SCRIPT" start "$2"
        ;;
    stop)
        "$SYNC_SCRIPT" stop
        ;;
    restart)
        "$SYNC_SCRIPT" restart "$2"
        ;;
    status)
        "$SYNC_SCRIPT" status
        ;;
    logs)
        LOGFILE="${HOME}/.local/state/proton-drive-cli/proton-fuse-daemon.log"
        # Fall back to legacy log
        [ ! -f "$LOGFILE" ] && LOGFILE="${HOME}/.local/state/proton-drive-cli/proton-sync-daemon.log"
        echo "Tailing logs (Ctrl+C to exit)..."
        tail -f "$LOGFILE"
        ;;
    ui)
        PORT="${PROTON_SYNC_PORT:-8085}"
        echo "Opening Web Dashboard at http://localhost:${PORT}..."
        if command -v xdg-open > /dev/null; then
            xdg-open "http://localhost:${PORT}"
        elif command -v open > /dev/null; then
            open "http://localhost:${PORT}"
        else
            echo "Please open http://localhost:${PORT} in your browser."
        fi
        ;;
    mount)
        echo "Mount point: ${MOUNT_POINT}"
        if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
            echo "Status: MOUNTED ✓"
        else
            echo "Status: Not mounted"
        fi
        ;;
    reset)
        echo "Stopping daemon..."
        "$SYNC_SCRIPT" stop
        echo "Resetting sync database and inode cache..."
        rm -f "${HOME}/.config/proton-drive-sync/sync_state.db"
        rm -rf "${HOME}/.local/share/proton-drive-fod"
        echo "Done. Start fresh with: ./drive.sh start"
        ;;
    sync-once)
        PORT="${PROTON_SYNC_PORT:-8085}"
        CUSTOM_PATH="$2"
        if [ -n "$CUSTOM_PATH" ]; then
            TARGET_PATH=$(realpath "$CUSTOM_PATH")
        else
            TARGET_PATH="${MOUNT_POINT}"
        fi
        echo "Running one-time synchronization pass..."
        PROTON_SYNC_ONCE=true PROTON_MOUNT_POINT="${TARGET_PATH}" PROTON_SYNC_PORT="${PORT}" PROTON_SYNC_MODE="full" "$CLI_BINARY"
        ;;
    build)
        echo "Building proton-fuse binary..."
        BUN_BIN="bun"
        if ! command -v bun >/dev/null 2>&1; then
            for p in "${SCRIPT_DIR}/node_modules/@oven/bun-linux-x64-baseline/bin/bun" \
                     "${SCRIPT_DIR}/node_modules/.bin/bun" \
                     "${SCRIPT_DIR}/sdk/js/cli/node_modules/.bin/bun"; do
                if [ -f "$p" ]; then
                    BUN_BIN="$p"
                    break
                fi
            done
        fi
        cd "${SCRIPT_DIR}/sdk/js/cli" && "$BUN_BIN" run build:fuse
        echo "Build complete: ${SCRIPT_DIR}/sdk/js/cli/release/proton-fuse"
        ;;
    tray)
        echo "Starting Proton Drive system tray icon..."
        TRAY_PIDFILE="${HOME}/.config/proton-drive-sync/tray.pid"
        TRAY_LOGFILE="${HOME}/.local/state/proton-drive-cli/proton-tray.log"
        mkdir -p "$(dirname "$TRAY_PIDFILE")"
        mkdir -p "$(dirname "$TRAY_LOGFILE")"

        if [ -f "$TRAY_PIDFILE" ]; then
            T_PID=$(cat "$TRAY_PIDFILE")
            if ps -p "$T_PID" > /dev/null 2>&1; then
                echo "Tray icon is already running (PID: $T_PID)."
                exit 0
            fi
        fi

        setsid "${SCRIPT_DIR}/proton-drive-tray.py" < /dev/null > "$TRAY_LOGFILE" 2>&1 &
        PID=$!
        sleep 0.5
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "$PID" > "$TRAY_PIDFILE"
            disown $PID
            echo "Tray icon started in background (PID: $PID). Logs: $TRAY_LOGFILE"
        else
            echo "ERROR: Failed to start tray icon. Logs: $TRAY_LOGFILE"
            rm -f "$TRAY_PIDFILE"
        fi
        ;;
    stop-tray)
        echo "Stopping Proton Drive system tray icon..."
        TRAY_PIDFILE="${HOME}/.config/proton-drive-sync/tray.pid"
        if [ -f "$TRAY_PIDFILE" ]; then
            T_PID=$(cat "$TRAY_PIDFILE")
            if ps -p "$T_PID" > /dev/null 2>&1; then
                kill "$T_PID"
                echo "Tray icon stopped (PID: $T_PID)."
            else
                echo "Tray icon is not running (stale PID file removed)."
            fi
            rm -f "$TRAY_PIDFILE"
        else
            T_PID=$(pgrep -f "python3 .*/proton-drive-tray.py" | head -n 1)
            if [ -n "$T_PID" ]; then
                kill "$T_PID"
                echo "Tray icon stopped (PID: $T_PID)."
            else
                echo "Tray icon is not running."
            fi
        fi
        ;;
    install-tray)
        mkdir -p "${HOME}/.config/autostart"
        sed "s|__INSTALL_DIR__|${SCRIPT_DIR}|g" \
            "${SCRIPT_DIR}/proton-drive-tray.desktop" \
            > "${HOME}/.config/autostart/proton-drive-tray.desktop"
        chmod +x "${HOME}/.config/autostart/proton-drive-tray.desktop"
        echo "Tray icon installed to ~/.config/autostart/ — will start automatically on desktop login."
        ;;
    uninstall-tray)
        rm -f "${HOME}/.config/autostart/proton-drive-tray.desktop"
        echo "Tray icon desktop entry removed from ~/.config/autostart/."
        ;;
    *)
        show_help
        ;;
esac
