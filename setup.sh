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
    if ! command -v node >/dev/null 2>&1; then
        echo "ERROR: Node.js 20.18 or newer is required to run the daemon."
        exit 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        echo "ERROR: Python 3 is required for the system tray."
        exit 1
    fi
    if ! command -v sqlite3 >/dev/null 2>&1; then
        echo "ERROR: sqlite3 is required by the launcher and maintenance commands."
        exit 1
    fi
    if ! command -v fusermount >/dev/null 2>&1 && ! command -v fusermount3 >/dev/null 2>&1; then
        echo "ERROR: FUSE userspace tools (fusermount or fusermount3) are required."
        exit 1
    fi
}

_do_build() {
    _check_bun
    echo "Installing Bun dependencies..."
    (cd "${SCRIPT_DIR}" && bun install --frozen-lockfile)

    echo "Building Proton Drive Sync Daemon binary..."
    mkdir -p "${SCRIPT_DIR}/release"
    (cd "${SCRIPT_DIR}" && bun run build)

    if [ ! -f "$BINARY" ]; then
        echo "ERROR: Build failed to produce binary at ${BINARY}"
        exit 1
    fi
    chmod +x "$BINARY"
    echo "Build complete."
}

# ── --rebuild flag handling ────────────────────────────────────────────────
if [ "$FORCE_REBUILD" -eq 1 ]; then
    echo "============================================="
    echo "    Proton Drive Linux — Rebuilding"
    echo "============================================="
    _do_build
    if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        echo "Restarting daemon (systemd) to pick up newly built binary..."
        systemctl --user restart "$SERVICE_NAME"
        echo "Daemon restarted."
    elif pgrep -f "[p]roton-sync" >/dev/null 2>&1 || [ -f "${HOME}/.config/proton-drive-sync/daemon.pid" ]; then
        echo "Restarting daemon (drive.sh) to pick up newly built binary..."
        "${SCRIPT_DIR}/drive.sh" restart
        echo "Daemon restarted."
    else
        echo "(Service/Daemon not running — start it with: ./drive.sh start)"
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
Environment=DISPLAY=${DISPLAY:-:0}
Environment=WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
Environment=PATH=${PATH}

[Install]
WantedBy=default.target
EOF

# Install desktop autostart entry dynamically
AUTOSTART_DIR="${HOME}/.config/autostart"
mkdir -p "${AUTOSTART_DIR}"
cat <<EOF > "${SCRIPT_DIR}/proton-drive-tray.desktop"
[Desktop Entry]
Type=Application
Name=Proton Drive Tray
Comment=Proton Drive System Tray Status Icon
Exec=${SCRIPT_DIR}/proton-drive-tray.py
Icon=${SCRIPT_DIR}/icons/icon.png
Terminal=false
Categories=Network;FileTransfer;
StartupNotify=false
X-GNOME-Autostart-enabled=true
EOF
cp "${SCRIPT_DIR}/proton-drive-tray.desktop" "${AUTOSTART_DIR}/proton-drive-tray.desktop"

# A previous drive.sh start runs outside the systemd service cgroup. Stop it
# before enabling the managed service so both processes cannot contend for the
# dashboard port or FUSE mount. The command is safe when nothing is running.
"${SCRIPT_DIR}/drive.sh" stop

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

echo ""
echo "============================================="
echo "  Setup complete!"
echo "  Daemon service is enabled and running."
echo "  Dashboard will be at:      http://localhost:8085"
echo "============================================="
