#!/bin/bash
# Proton Drive Linux — one-shot setup script
# Installs the systemd user service and enables it to start on login.
# Run once after cloning; afterwards manage the daemon with:
#   ./drive.sh start | stop | status | logs
#
# Flags:
#   --rebuild    Force a recompile of the sync binary even if it already exists

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="proton-sync.service"
SYSTEMD_DIR="${HOME}/.config/systemd/user"
SERVICE_SRC="${SCRIPT_DIR}/${SERVICE_NAME}"
SERVICE_DST="${SYSTEMD_DIR}/${SERVICE_NAME}"
BINARY="${SCRIPT_DIR}/sdk/js/cli/release/proton-sync"
FORCE_REBUILD=0

for arg in "$@"; do
    [ "$arg" = "--rebuild" ] && FORCE_REBUILD=1
done

echo "============================================="
echo "    Proton Drive Linux — Setup"
echo "============================================="

# ── Build helper (defined early so --rebuild can call it) ────────────────────
_do_build() {
    BUN_BIN=""
    if command -v bun >/dev/null 2>&1; then
        BUN_BIN="bun"
    else
        for _p in \
            "${SCRIPT_DIR}/node_modules/@oven/bun-linux-x64-baseline/bin/bun" \
            "${SCRIPT_DIR}/node_modules/.bin/bun" \
            "${SCRIPT_DIR}/sdk/js/cli/node_modules/.bin/bun"; do
            if [ -f "$_p" ]; then BUN_BIN="$_p"; break; fi
        done
    fi

    if [ -z "$BUN_BIN" ]; then
        echo "ERROR: bun is required to build but was not found."
        echo "Install it with:  curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi

    echo "Using bun: ${BUN_BIN}"
    (cd "${SCRIPT_DIR}/sdk/js/cli" && "$BUN_BIN" install --frozen-lockfile)
    (cd "${SCRIPT_DIR}/sdk/js/cli" && "$BUN_BIN" run build)

    if [ ! -f "$BINARY" ]; then
        echo "ERROR: Build finished but binary still missing at: ${BINARY}"
        exit 1
    fi
    echo "Build complete."
    echo ""
}

# ── --rebuild: recompile only, then restart if running ───────────────────────
if [ "$FORCE_REBUILD" -eq 1 ]; then
    echo "Rebuilding binary..."
    echo ""
    _do_build
    if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        echo "Restarting daemon to pick up new binary..."
        systemctl --user restart "$SERVICE_NAME"
    else
        echo "(Service not running — start it with: ./drive.sh start)"
    fi
    # Restart tray so it reconnects to the restarted daemon
    "${SCRIPT_DIR}/drive.sh" stop-tray 2>/dev/null || true
    sleep 1
    "${SCRIPT_DIR}/drive.sh" tray
    echo "Done."
    exit 0
fi

# ── Detect existing install ───────────────────────────────────────────────────
ALREADY_INSTALLED=0
WAS_RUNNING=0

if [ -f "$SERVICE_DST" ] || systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    ALREADY_INSTALLED=1
    echo ""
    echo "Existing installation detected."

    if [ -f "$SERVICE_DST" ]; then
        CURRENT_SYNC=$(grep "^Environment=PROTON_MOUNT_POINT=" "$SERVICE_DST" 2>/dev/null | cut -d= -f3-)
        [ -n "$CURRENT_SYNC" ] && echo "  Current sync folder : ${CURRENT_SYNC}"
    fi

    if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        WAS_RUNNING=1
        echo "  Service status      : running"
    else
        echo "  Service status      : stopped"
    fi

    echo ""
    printf "Reconfigure? This will restart the daemon. [y/N]: "
    read -r _confirm
    case "$_confirm" in
        [yY]|[yY][eE][sS]) ;;
        *) echo "Aborted — no changes made."; exit 0 ;;
    esac

    if [ "$WAS_RUNNING" -eq 1 ]; then
        echo "Stopping daemon..."
        systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    fi
fi

# ── 1. Build binary (first-time only) ────────────────────────────────────────
if [ ! -f "$BINARY" ]; then
    echo "Binary not found — building now..."
    echo ""
    _do_build
else
    echo "Binary found — skipping build. Use --rebuild to recompile."
fi

# ── 2. Install the systemd service ───────────────────────────────────────────
mkdir -p "$SYSTEMD_DIR"

# Substitute the actual project directory into ExecStart.
# The template uses __INSTALL_DIR__ so the service works regardless of where
# the repo is cloned (~/Code/..., ~/Projects/..., etc.)
sed "s|__INSTALL_DIR__|${SCRIPT_DIR}|g" "$SERVICE_SRC" > "$SERVICE_DST"

echo "Installed: ${SERVICE_DST}"

# ── 3. Set sync folder ───────────────────────────────────────────────────────
echo ""

# Default to the existing folder if reconfiguring, otherwise ~/P-Drive
if [ -n "$CURRENT_SYNC" ]; then
    DEFAULT_SYNC_DIR="$CURRENT_SYNC"
else
    DEFAULT_SYNC_DIR="${HOME}/P-Drive"
fi

printf "Sync folder [default: ${DEFAULT_SYNC_DIR}]: "
read -r SYNC_DIR
SYNC_DIR="${SYNC_DIR:-${DEFAULT_SYNC_DIR}}"
SYNC_DIR="${SYNC_DIR/#\~/${HOME}}"   # expand leading ~

mkdir -p "$SYNC_DIR"
echo "Sync folder: ${SYNC_DIR}"

# Persist the mount point in the service environment
if grep -q "^Environment=PROTON_MOUNT_POINT=" "$SERVICE_DST" 2>/dev/null; then
    sed -i "s|^Environment=PROTON_MOUNT_POINT=.*|Environment=PROTON_MOUNT_POINT=${SYNC_DIR}|" "$SERVICE_DST"
else
    sed -i "/^\[Service\]/a Environment=PROTON_MOUNT_POINT=${SYNC_DIR}" "$SERVICE_DST"
fi

# ── 4. Enable & (re)start ────────────────────────────────────────────────────
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user start  "$SERVICE_NAME"

# Give the service a moment to settle, then verify it actually came up
sleep 2
if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
    echo ""
    echo "ERROR: Service started but is not running. Check logs:"
    echo "  journalctl --user -u ${SERVICE_NAME} -n 30 --no-pager"
    systemctl --user status "$SERVICE_NAME" --no-pager 2>/dev/null || true
    exit 1
fi

# ── 5. Start / restart tray icon ─────────────────────────────────────────────
"${SCRIPT_DIR}/drive.sh" stop-tray 2>/dev/null || true
sleep 1
"${SCRIPT_DIR}/drive.sh" tray

echo ""
echo "============================================="
if [ "$ALREADY_INSTALLED" -eq 1 ]; then
    echo "  Proton Drive reconfigured and restarted!"
else
    echo "  Proton Drive is now running!"
fi
echo ""
echo "  Sync folder  : ${SYNC_DIR}"
echo "  Dashboard    : http://localhost:8085"
echo ""
echo "  Useful commands:"
echo "    ./drive.sh status          — check daemon status"
echo "    ./drive.sh logs            — tail live logs"
echo "    ./drive.sh stop / start    — manual control"
echo "    journalctl --user -u ${SERVICE_NAME} -f"
echo ""
echo "  To remove: run ./uninstall.sh"
echo "============================================="
