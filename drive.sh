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
    echo ""
    echo "Network & Performance Commands:"
    echo "  wifi-safe [on|off] - Enable/disable Wi-Fi Safe Mode (pacing & 1-file concurrency)"
    echo "  limit [KB/s]       - Set maximum bandwidth speed limit (e.g. limit 1000)"
    echo "============================================="
}

# Helper to start daemon
start_daemon() {
    CUSTOM_PATH="$1"
    MODE_ARG=""

    for arg in "$1" "$2" "$3"; do
        if [ "$arg" = "--mode=fuse" ]; then
            MODE_ARG="fuse"
        elif [ "$arg" = "--mode=full" ]; then
            MODE_ARG="full"
        fi
    done

    DB_FILE="${HOME}/.config/proton-drive-sync/sync_state.db"
    STORED_MODE=""
    STORED_PATH=""
    STORED_FUSE_MOUNT=""
    if [ -f "$DB_FILE" ] && command -v sqlite3 >/dev/null 2>&1; then
        STORED_MODE="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='sync_mode';" 2>/dev/null)"
        STORED_PATH="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='local_sync_path';" 2>/dev/null)"
        STORED_FUSE_MOUNT="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='fuse_mount_point';" 2>/dev/null)"
    fi

    # Mode precedence: 1. CLI flag, 2. Stored DB mode, 3. Default 'full'
    SYNC_MODE="full"
    if [ -n "$MODE_ARG" ]; then
        SYNC_MODE="$MODE_ARG"
    elif [ "$STORED_MODE" = "fuse" ]; then
        SYNC_MODE="fuse"
    fi

    # Target folder resolution
    if [ -n "$CUSTOM_PATH" ] && [ "$CUSTOM_PATH" != "--mode=fuse" ] && [ "$CUSTOM_PATH" != "--mode=full" ]; then
        RESOLVED_PATH="${CUSTOM_PATH/#\~/$HOME}"
        TARGET_DIR="$(mkdir -p "$RESOLVED_PATH" && cd "$RESOLVED_PATH" && pwd)"
    else
        if [ "$SYNC_MODE" = "fuse" ]; then
            TARGET_DIR="${STORED_FUSE_MOUNT:-${HOME}/P-Drive-FUSE}"
        else
            TARGET_DIR="${STORED_PATH:-${HOME}/P-Drive}"
        fi
    fi

    # Stop daemon & unmount active FUSE points before launching
    stop_daemon >/dev/null 2>&1 || true

    mkdir -p "$TARGET_DIR"
    export PROTON_MOUNT_POINT="$TARGET_DIR"
    export PROTON_SYNC_MODE="$SYNC_MODE"

    # Persist config state into SQLite DB for cross-process consistency
    mkdir -p "${HOME}/.config/proton-drive-sync"
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$DB_FILE" "CREATE TABLE IF NOT EXISTS sync_config (key TEXT PRIMARY KEY, value TEXT);" 2>/dev/null || true
        sqlite3 "$DB_FILE" "INSERT OR REPLACE INTO sync_config (key, value) VALUES ('sync_mode', '${SYNC_MODE}');" 2>/dev/null || true
        if [ "$SYNC_MODE" = "fuse" ]; then
            sqlite3 "$DB_FILE" "INSERT OR REPLACE INTO sync_config (key, value) VALUES ('fuse_mount_point', '${TARGET_DIR}');" 2>/dev/null || true
        else
            sqlite3 "$DB_FILE" "INSERT OR REPLACE INTO sync_config (key, value) VALUES ('local_sync_path', '${TARGET_DIR}');" 2>/dev/null || true
        fi
    fi

    echo "============================================="
    echo " Starting Proton Drive Daemon"
    echo " Mode:            ${SYNC_MODE^^}"
    echo " Target Folder:   ${TARGET_DIR}"
    echo "============================================="

    NODE_BIN="$(command -v node || echo /usr/bin/node)"
    LOGFILE="${HOME}/.config/proton-drive-sync/daemon.log"
    # Use setsid to create a new session so the daemon survives shell exit
    setsid env PROTON_SYNC_MODE="$SYNC_MODE" PROTON_MOUNT_POINT="$TARGET_DIR" \
        "$NODE_BIN" "${SCRIPT_DIR}/release/proton-sync.js" \
        > "$LOGFILE" 2>&1 &
    DAEMON_PID=$!
    disown "$DAEMON_PID" 2>/dev/null || true
    echo "$DAEMON_PID" > "${HOME}/.config/proton-drive-sync/daemon.pid"
    sleep 1

    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "ERROR: Daemon failed to start. Check logs: $LOGFILE"
        cat "$LOGFILE"
        exit 1
    fi

    echo "Daemon running with PID ${DAEMON_PID}."

    if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
        if [ -f "$TRAY_SCRIPT" ]; then
            if ! pgrep -f "proton-drive-tray.py" > /dev/null 2>&1; then
                echo "Starting system tray..."
                nohup python3 "$TRAY_SCRIPT" > "${HOME}/.config/proton-drive-sync/tray.log" 2>&1 &
            fi
        fi
    fi
}

stop_daemon() {
    echo "Stopping Proton Drive daemon, systemd service, unmounting FUSE, and stopping tray..."
    systemctl --user stop proton-sync.service 2>/dev/null || true

    DB_FILE="${HOME}/.config/proton-drive-sync/sync_state.db"
    STORED_FUSE=""
    if [ -f "$DB_FILE" ] && command -v sqlite3 >/dev/null 2>&1; then
        STORED_FUSE="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='fuse_mount_point';" 2>/dev/null)"
    fi

    if [ -f "${HOME}/.config/proton-drive-sync/daemon.pid" ]; then
        STORED_PID="$(cat "${HOME}/.config/proton-drive-sync/daemon.pid" 2>/dev/null)"
        if [ -n "$STORED_PID" ] && kill -0 "$STORED_PID" 2>/dev/null; then
            kill "$STORED_PID" 2>/dev/null && sleep 1
        fi
        rm -f "${HOME}/.config/proton-drive-sync/daemon.pid"
    fi
    pkill -f "[p]roton-sync" 2>/dev/null || true
    pkill -f "[p]roton-drive-launcher.sh" 2>/dev/null || true
    pkill -f "[p]roton-drive-tray.py" 2>/dev/null || true

    # Clean unmount default & stored FUSE mount points
    fusermount -u -z "${HOME}/P-Drive-FUSE" 2>/dev/null || umount -l "${HOME}/P-Drive-FUSE" 2>/dev/null || true
    if [ -n "$STORED_FUSE" ] && [ "$STORED_FUSE" != "${HOME}/P-Drive-FUSE" ]; then
        fusermount -u -z "$STORED_FUSE" 2>/dev/null || umount -l "$STORED_FUSE" 2>/dev/null || true
    fi
    echo "Stopped cleanly."
}

cmd="${1:-help}"
case "$cmd" in
    start)
        start_daemon "$2" "$3"
        ;;
    mode)
        TARGET_MODE="${2:-full}"
        if [ "$TARGET_MODE" != "full" ] && [ "$TARGET_MODE" != "fuse" ]; then
            echo "ERROR: Invalid mode '$TARGET_MODE'. Valid modes: full, fuse"
            exit 1
        fi
        NEW_PATH="$3"
        echo "Switching Proton Drive sync mode to ${TARGET_MODE^^}..."
        stop_daemon
        start_daemon "$NEW_PATH" "--mode=${TARGET_MODE}"
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        start_daemon "$2" "$3"
        ;;
    status)
        DB_FILE="${HOME}/.config/proton-drive-sync/sync_state.db"
        MODE_VAL="full"
        PATH_VAL="${HOME}/P-Drive"
        FUSE_VAL="${HOME}/P-Drive-FUSE"

        if [ -f "$DB_FILE" ] && command -v sqlite3 >/dev/null 2>&1; then
            DB_MODE="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='sync_mode';" 2>/dev/null)"
            [ -n "$DB_MODE" ] && MODE_VAL="$DB_MODE"
            DB_PATH="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='local_sync_path';" 2>/dev/null)"
            [ -n "$DB_PATH" ] && PATH_VAL="$DB_PATH"
            DB_FUSE="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='fuse_mount_point';" 2>/dev/null)"
            [ -n "$DB_FUSE" ] && FUSE_VAL="$DB_FUSE"
        fi

        ACTIVE_PATH="$PATH_VAL"
        [ "$MODE_VAL" = "fuse" ] && ACTIVE_PATH="$FUSE_VAL"

        echo "============================================="
        echo "         Proton Drive Client Status          "
        echo "============================================="
        echo " Active Mode:     ${MODE_VAL^^}"
        echo " Active Path:     ${ACTIVE_PATH}"

        # FUSE Mount Status
        FUSE_MOUNTED="No"
        if mountpoint -q "$ACTIVE_PATH" 2>/dev/null || grep -q " $ACTIVE_PATH fuse" /proc/mounts 2>/dev/null; then
            FUSE_MOUNTED="Yes (Mounted)"
        fi
        echo " FUSE Mounted:    ${FUSE_MOUNTED}"

        # Daemon Process Status
        DAEMON_INFO="Not Running"
        if pgrep -f "[p]roton-sync" >/dev/null 2>&1; then
            DPID="$(pgrep -f "[p]roton-sync" | head -n 1)"
            DAEMON_INFO="Running (PID: $DPID)"
        fi
        echo " Daemon Status:   ${DAEMON_INFO}"

        # Tray Icon Status
        TRAY_INFO="Not Running"
        if pgrep -f "[p]roton-drive-tray.py" >/dev/null 2>&1; then
            TPID="$(pgrep -f "[p]roton-drive-tray.py" | head -n 1)"
            TRAY_INFO="Running (PID: $TPID)"
        fi
        echo " System Tray:     ${TRAY_INFO}"

        echo " Web Dashboard:   http://localhost:8085"
        echo "============================================="
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
        echo "Stopping daemon, systemd service, and tray..."
        stop_daemon
        echo "Clearing local sync databases, state, and caches..."
        rm -rf "${HOME}/.config/proton-drive-sync"
        rm -rf "${HOME}/.config/proton-drive"
        rm -rf "${HOME}/.local/share/proton-drive-cli"
        rm -rf "${HOME}/.local/state/proton-drive-cli"
        rm -rf "${HOME}/.cache/proton-drive-cli"
        echo "Local sync state completely cleared."
        echo "Reset complete. Start daemon with: ./drive.sh start [path]"
        ;;
    wifi-safe)
        ENABLE_ARG="${2:-on}"
        if [ "$ENABLE_ARG" = "off" ] || [ "$ENABLE_ARG" = "false" ] || [ "$ENABLE_ARG" = "0" ]; then
            echo "Disabling Wi-Fi Safe Mode..."
            curl -s -X POST http://localhost:8085/api/set-wifi-safe-mode -H "Content-Type: application/json" -d '{"enabled": false}' >/dev/null || true
            if command -v sqlite3 >/dev/null 2>&1; then
                sqlite3 "${HOME}/.config/proton-drive-sync/sync_state.db" "INSERT OR REPLACE INTO sync_config (key, value) VALUES ('sync_wifi_safe_mode', '0');" 2>/dev/null || true
            fi
            echo "Wi-Fi Safe Mode disabled."
        else
            echo "Enabling Wi-Fi Safe Mode..."
            curl -s -X POST http://localhost:8085/api/set-wifi-safe-mode -H "Content-Type: application/json" -d '{"enabled": true}' >/dev/null || true
            if command -v sqlite3 >/dev/null 2>&1; then
                sqlite3 "${HOME}/.config/proton-drive-sync/sync_state.db" "INSERT OR REPLACE INTO sync_config (key, value) VALUES ('sync_wifi_safe_mode', '1');" 2>/dev/null || true
                sqlite3 "${HOME}/.config/proton-drive-sync/sync_state.db" "INSERT OR REPLACE INTO sync_config (key, value) VALUES ('sync_concurrency', '1');" 2>/dev/null || true
            fi
            echo "Wi-Fi Safe Mode enabled (concurrency=1, download streaming micro-yield pacing enabled)."
        fi
        ;;
    limit)
        SPEED_KBPS="${2:-1000}"
        echo "Setting download speed limit to ${SPEED_KBPS} KB/s..."
        curl -s -X POST http://localhost:8085/api/set-speed-limit -H "Content-Type: application/json" -d "{\"maxSpeedKbps\": ${SPEED_KBPS}}" >/dev/null || true
        if command -v sqlite3 >/dev/null 2>&1; then
            sqlite3 "${HOME}/.config/proton-drive-sync/sync_state.db" "INSERT OR REPLACE INTO sync_config (key, value) VALUES ('sync_max_speed_kbps', '${SPEED_KBPS}');" 2>/dev/null || true
        fi
        echo "Speed limit set to ${SPEED_KBPS} KB/s."
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
