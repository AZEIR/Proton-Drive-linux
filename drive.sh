#!/bin/bash
# Unified Proton Drive CLI Wrapper — FOD (File-On-Demand) Mode

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/start-sync.sh"
CLI_BINARY="${SCRIPT_DIR}/proton-drive"
MOUNT_POINT="${PROTON_MOUNT_POINT:-${HOME}/P-Drive}"

show_help() {
    echo "============================================="
    echo "    Proton Drive Linux FOD Client            "
    echo "============================================="
    echo "Usage: $0 [command]"
    echo ""
    echo "Daemon Commands:"
    echo "  start   - Mount Proton Drive as a FUSE filesystem"
    echo "  stop    - Unmount and stop the daemon"
    echo "  restart - Restart the daemon"
    echo "  status  - Check daemon status & view dashboard link"
    echo ""
    echo "File Commands:"
    echo "  login   - Authenticate your Proton account"
    echo "  logs    - View real-time daemon logs"
    echo "  ui      - Open the Web Dashboard in your browser"
    echo "  mount   - Show current mount point"
    echo "  reset   - Clear local sync database & inode cache"
    echo "  sync-once - Run a single complete synchronization pass and exit"
    echo ""
    echo "Legacy Full-Sync Mode:"
    echo "  PROTON_SYNC_MODE=full ./drive.sh start"
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
    *)
        show_help
        ;;
esac
