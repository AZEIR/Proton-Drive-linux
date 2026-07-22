#!/bin/bash
# Proton Drive Linux — Setup Script
# Flags:
#   --rebuild    Force a recompile of the binary and restart the daemon

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="proton-sync.service"
SYSTEMD_DIR="${HOME}/.config/systemd/user"
SERVICE_DST="${SYSTEMD_DIR}/${SERVICE_NAME}"
BINARY="${SCRIPT_DIR}/release/proton-sync"
FORCE_REBUILD=0

for arg in "$@"; do
    [ "$arg" = "--rebuild" ] && FORCE_REBUILD=1
done

# Ensure Bun is available
_check_bun() {
    if ! command -v bun >/dev/null 2>&1; then
        echo "ERROR: Bun is required to build but was not found."
        echo "Install with: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
}

_do_build() {
    _check_bun
    echo "Installing Bun dependencies..."
    (cd "${SCRIPT_DIR}" && bun install)

    echo "Building Proton Drive Sync Daemon binary..."
    mkdir -p "${SCRIPT_DIR}/release"
    (cd "${SCRIPT_DIR}" && bun run build)

    chmod +x "$BINARY"
    if [ ! -f "$BINARY" ]; then
        echo "ERROR: Build failed to produce binary at ${BINARY}"
        exit 1
    fi
    echo "Build complete."
}

# ── --rebuild flag handling ────────────────────────────────────────────────
if [ "$FORCE_REBUILD" -eq 1 ]; then
    echo "============================================="
    echo "    Proton Drive Linux — Rebuilding"
    echo "============================================="
    _do_build
    if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        echo "Restarting daemon to pick up newly built binary..."
        systemctl --user restart "$SERVICE_NAME"
        echo "Daemon restarted."
    else
        echo "(Service not running — start it with: ./drive.sh start)"
    fi
    echo "Done."
    exit 0
fi

# ── Normal setup flow ──────────────────────────────────────────────────────
echo "============================================="
echo "    Proton Drive Linux — Setup"
echo "============================================="

_do_build

# Install systemd services for daemon and tray icon
mkdir -p "${SYSTEMD_DIR}"
cat <<EOF > "$SERVICE_DST"
[Unit]
Description=Proton Drive Linux Sync Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BINARY}
Restart=always
RestartSec=5s
Environment=PROTON_MOUNT_POINT=${HOME}/P-Drive

[Install]
WantedBy=default.target
EOF

TRAY_SERVICE_NAME="proton-drive-tray.service"
TRAY_SERVICE_DST="${SYSTEMD_DIR}/${TRAY_SERVICE_NAME}"

if [ -f "${SCRIPT_DIR}/proton-drive-tray.service.template" ]; then
    sed -e "s|{{SCRIPT_DIR}}|${SCRIPT_DIR}|g" \
        -e "s|{{DISPLAY}}|${DISPLAY:-:0}|g" \
        -e "s|{{WAYLAND_DISPLAY}}|${WAYLAND_DISPLAY:-wayland-0}|g" \
        -e "s|{{PATH}}|${PATH}|g" \
        -e "s|{{PORT}}|8085|g" \
        "${SCRIPT_DIR}/proton-drive-tray.service.template" > "$TRAY_SERVICE_DST"
fi

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user enable "$TRAY_SERVICE_NAME" 2>/dev/null || true
systemctl --user restart "$SERVICE_NAME"
systemctl --user restart "$TRAY_SERVICE_NAME" 2>/dev/null || true

echo ""
echo "Setup finished successfully!"
echo "Daemon status: systemctl --user status proton-sync"
echo "Tray status:   systemctl --user status proton-drive-tray"
echo "Dashboard:     http://localhost:8085"
