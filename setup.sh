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

# Install single unified systemd service
mkdir -p "${SYSTEMD_DIR}"
cat <<EOF > "$SERVICE_DST"
[Unit]
Description=Proton Drive Linux Sync Client
After=network-online.target graphical-session.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${SCRIPT_DIR}/proton-drive-launcher.sh
WorkingDirectory=${SCRIPT_DIR}
Restart=always
RestartSec=5s
Environment=PROTON_MOUNT_POINT=${HOME}/P-Drive
Environment=DISPLAY=${DISPLAY:-:0}
Environment=WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
Environment=PATH=${PATH}

[Install]
WantedBy=default.target
EOF

# Clean up any legacy separate tray service if present
systemctl --user stop proton-drive-tray.service 2>/dev/null || true
systemctl --user disable proton-drive-tray.service 2>/dev/null || true
rm -f "${SYSTEMD_DIR}/proton-drive-tray.service"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME" || true

echo ""
echo "============================================="
echo "  Setup complete!"
echo "  Service status: systemctl --user status proton-sync"
echo "  Dashboard:      http://localhost:8085"
echo "============================================="
