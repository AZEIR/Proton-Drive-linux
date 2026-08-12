#!/bin/bash
# Proton Drive Linux — Management Script (no systemd)

umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${HOME}/.config/proton-drive-sync"
DAEMON_LOG="${CONFIG_DIR}/daemon.log"
DAEMON_PID_FILE="${CONFIG_DIR}/daemon.pid"

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

find_processes_with_exact_arg() {
    local target_arg="$1"
    local cmdline_file pid arg matched

    for cmdline_file in /proc/[0-9]*/cmdline; do
        matched=0
        while IFS= read -r -d '' arg; do
            if [ "$arg" = "$target_arg" ]; then
                matched=1
                break
            fi
        done 2>/dev/null < "$cmdline_file" || true
        if [ "$matched" -eq 1 ]; then
            pid="${cmdline_file#/proc/}"
            pid="${pid%/cmdline}"
            if [ "$pid" != "$$" ] && [ "$pid" != "$PPID" ]; then
                echo "$pid"
            fi
        fi
    done
}

terminate_processes_with_exact_arg() {
    local target_arg="$1"
    local -a matched_pids=()
    mapfile -t matched_pids < <(find_processes_with_exact_arg "$target_arg")

    if [ "${#matched_pids[@]}" -gt 0 ]; then
        kill "${matched_pids[@]}" 2>/dev/null || true
    fi
}

IMMUTABLE_DAEMON_BIN="${HOME}/.local/lib/drive-for-linux/current/proton-sync"
if [ -x "$IMMUTABLE_DAEMON_BIN" ]; then
    DAEMON_BIN="$IMMUTABLE_DAEMON_BIN"
else
    DAEMON_BIN="${SCRIPT_DIR}/release/proton-sync"
fi
DAEMON_JS="$(cd "$(dirname "$DAEMON_BIN")" && pwd)/proton-sync.js"
TRAY_SCRIPT="${SCRIPT_DIR}/proton-drive-tray.py"

get_authenticated_dashboard_url() {
    local control_socket_path="${XDG_RUNTIME_DIR:-/tmp/drive-for-linux-$(id -u)}/drive-for-linux/control.sock"
    python3 - "$control_socket_path" <<'PY'
import json
import socket
import sys

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    client.settimeout(2)
    client.connect(sys.argv[1])
    client.sendall(b'{"command":"dashboard-url"}\n')
    response = b""
    while b"\n" not in response:
        chunk = client.recv(4096)
        if not chunk:
            break
        response += chunk
payload = json.loads(response.decode("utf-8"))
if not payload.get("ok") or not payload.get("url"):
    raise SystemExit(1)
print(payload["url"])
PY
}

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

    DB_FILE="${CONFIG_DIR}/sync_state.db"
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
    mkdir -p "$CONFIG_DIR"
    chmod 700 "$CONFIG_DIR"
    export PROTON_SYNC_MODE="$SYNC_MODE"
    if [ "$SYNC_MODE" = "fuse" ]; then
        export PROTON_FUSE_MOUNT_POINT="$TARGET_DIR"
        unset PROTON_FULL_SYNC_PATH
    else
        export PROTON_FULL_SYNC_PATH="$TARGET_DIR"
        unset PROTON_FUSE_MOUNT_POINT
    fi

    echo "============================================="
    echo " Starting Proton Drive Daemon"
    echo " Mode:            ${SYNC_MODE^^}"
    echo " Target Folder:   ${TARGET_DIR}"
    echo "============================================="

    LOGFILE="$DAEMON_LOG"
    touch "$LOGFILE"
    chmod 600 "$LOGFILE"
    # Use setsid to create a new session so the daemon survives shell exit
    if [ "$SYNC_MODE" = "fuse" ]; then
        setsid env PROTON_SYNC_MODE="$SYNC_MODE" PROTON_FUSE_MOUNT_POINT="$TARGET_DIR" \
            "$DAEMON_BIN" \
            > "$LOGFILE" 2>&1 &
    else
        setsid env PROTON_SYNC_MODE="$SYNC_MODE" PROTON_FULL_SYNC_PATH="$TARGET_DIR" \
            "$DAEMON_BIN" \
            > "$LOGFILE" 2>&1 &
    fi
    DAEMON_PID=$!
    disown "$DAEMON_PID" 2>/dev/null || true
    echo "$DAEMON_PID" > "$DAEMON_PID_FILE"
    chmod 600 "$DAEMON_PID_FILE"
    sleep 1

    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "ERROR: Daemon failed to start. Check logs: $LOGFILE"
        cat "$LOGFILE"
        exit 1
    fi

    echo "Daemon running with PID ${DAEMON_PID}."

    if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
        if [ -f "$TRAY_SCRIPT" ]; then
            if [ -z "$(find_processes_with_exact_arg "$TRAY_SCRIPT" | head -n 1)" ]; then
                echo "Starting system tray..."
                setsid -f python3 "$TRAY_SCRIPT" \
                    > "${CONFIG_DIR}/tray.log" 2>&1 < /dev/null
            fi
        fi
    fi
}

stop_daemon() {
    echo "Stopping Proton Drive daemon, systemd service, unmounting FUSE, and stopping tray..."
    systemctl --user stop drive-core.service 2>/dev/null || true
    systemctl --user stop proton-sync.service 2>/dev/null || true

    DB_FILE="${CONFIG_DIR}/sync_state.db"
    STORED_FUSE=""
    if [ -f "$DB_FILE" ] && command -v sqlite3 >/dev/null 2>&1; then
        STORED_FUSE="$(sqlite3 "$DB_FILE" "SELECT value FROM sync_config WHERE key='fuse_mount_point';" 2>/dev/null)"
    fi

    if [ -f "$DAEMON_PID_FILE" ]; then
        STORED_PID="$(cat "$DAEMON_PID_FILE" 2>/dev/null)"
        if [ -n "$STORED_PID" ] && kill -0 "$STORED_PID" 2>/dev/null; then
            kill "$STORED_PID" 2>/dev/null && sleep 1
        fi
        rm -f "$DAEMON_PID_FILE"
    fi
    terminate_processes_with_exact_arg "$DAEMON_JS"
    if [ "$DAEMON_JS" != "${SCRIPT_DIR}/release/proton-sync.js" ]; then
        terminate_processes_with_exact_arg "${SCRIPT_DIR}/release/proton-sync.js"
    fi
    terminate_processes_with_exact_arg "${SCRIPT_DIR}/proton-drive-launcher.sh"
    terminate_processes_with_exact_arg "$TRAY_SCRIPT"

    # Clean unmount default & stored FUSE mount points
    unmount_fuse_path "${HOME}/P-Drive-FUSE"
    if [ -n "$STORED_FUSE" ] && [ "$STORED_FUSE" != "${HOME}/P-Drive-FUSE" ]; then
        unmount_fuse_path "$STORED_FUSE"
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
        DB_FILE="${CONFIG_DIR}/sync_state.db"
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
        DPID=""
        if [ -f "$DAEMON_PID_FILE" ]; then
            DPID="$(cat "$DAEMON_PID_FILE" 2>/dev/null)"
            if [ -z "$DPID" ] || ! kill -0 "$DPID" 2>/dev/null; then
                DPID=""
            fi
        fi
        if [ -z "$DPID" ]; then
            DPID="$(find_processes_with_exact_arg "$DAEMON_JS" | head -n 1)"
        fi
        if [ -z "$DPID" ] && [ "$DAEMON_JS" != "${SCRIPT_DIR}/release/proton-sync.js" ]; then
            DPID="$(find_processes_with_exact_arg "${SCRIPT_DIR}/release/proton-sync.js" | head -n 1)"
        fi
        if [ -n "$DPID" ]; then
            DAEMON_INFO="Running (PID: $DPID)"
        fi
        echo " Daemon Status:   ${DAEMON_INFO}"

        # Tray Icon Status
        TRAY_INFO="Not Running"
        TPID="$(find_processes_with_exact_arg "$TRAY_SCRIPT" | head -n 1)"
        if [ -n "$TPID" ]; then
            TRAY_INFO="Running (PID: $TPID)"
        fi
        echo " System Tray:     ${TRAY_INFO}"

        echo " Web Dashboard:   run ./drive.sh ui"
        echo "============================================="
        ;;
    logs)
        LOG_FILE="${HOME}/.local/state/proton-drive-cli/proton-drive.log"
        echo "Tailing daemon logs (Ctrl+C to exit)..."
        if [ -f "$LOG_FILE" ] && [ -f "$DAEMON_LOG" ]; then
            tail -F "$DAEMON_LOG" "$LOG_FILE"
        elif [ -f "$LOG_FILE" ]; then
            tail -F "$LOG_FILE"
        else
            mkdir -p "$CONFIG_DIR"
            touch "$DAEMON_LOG"
            tail -F "$DAEMON_LOG"
        fi
        ;;
    ui|dashboard)
        PORT=8085
        echo "Opening authenticated Web Dashboard..."
        DASHBOARD_URL="$(get_authenticated_dashboard_url)" || {
            echo "Dashboard authorization is unavailable. Make sure the daemon is running."
            exit 1
        }
        if command -v xdg-open > /dev/null; then
            xdg-open "$DASHBOARD_URL" 2>/dev/null
        elif command -v open > /dev/null; then
            open "$DASHBOARD_URL"
        else
            echo "Use the tray icon to open the authenticated dashboard."
        fi
        ;;
    login)
        echo "Opening authentication page..."
        DASHBOARD_URL="$(get_authenticated_dashboard_url)" || {
            echo "Dashboard authorization is unavailable. Make sure the daemon is running."
            exit 1
        }
        xdg-open "$DASHBOARD_URL" 2>/dev/null || echo "Use the tray icon to open the authenticated dashboard."
        ;;
    reset)
        echo "Stopping daemon, systemd service, and tray..."
        stop_daemon
        echo "Clearing local sync databases, state, and caches..."
        rm -rf "$CONFIG_DIR"
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
