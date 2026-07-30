#!/bin/bash
# Proton Drive Linux — Setup Script
# Flags:
#   --rebuild    Force a recompile of the binary and restart the daemon

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="drive-core.service"
LEGACY_SERVICE_NAME="proton-sync.service"
SYSTEMD_DIR="${HOME}/.config/systemd/user"
SERVICE_DST="${SYSTEMD_DIR}/${SERVICE_NAME}"
RELEASE_BINARY="${SCRIPT_DIR}/release/proton-sync"
INSTALL_BASE="${HOME}/.local/lib/drive-for-linux"
CURRENT_LINK="${INSTALL_BASE}/current"
PREVIOUS_LINK="${INSTALL_BASE}/previous"
BINARY="${CURRENT_LINK}/proton-sync"
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
        echo "ERROR: Node.js 22 or newer is required to run the daemon."
        exit 1
    fi
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$NODE_MAJOR" -lt 22 ]; then
        echo "ERROR: Node.js 22 or newer is required (found $(node --version))."
        exit 1
    fi
    if ! command -v cargo >/dev/null 2>&1 || ! pkg-config --exists fuse3; then
        echo "ERROR: Rust/Cargo and the FUSE 3 development package are required."
        exit 1
    fi
    if [ "${PROTON_DRIVE_CREDENTIALS_STORE:-}" != "unsafe_file" ]; then
        IS_KDE_SESSION=0
        case "${XDG_CURRENT_DESKTOP:-}:${DESKTOP_SESSION:-}:${KDE_FULL_SESSION:-}" in
            *KDE*|*kde*|*Plasma*|*plasma*) IS_KDE_SESSION=1 ;;
        esac
        if [ "$IS_KDE_SESSION" -eq 1 ]; then
            if ! command -v kwallet-query >/dev/null 2>&1; then
                echo "ERROR: kwallet-query is required for secure credential storage on KDE Plasma."
                exit 1
            fi
            if ! command -v qdbus6 >/dev/null 2>&1 &&
               ! command -v qdbus-qt6 >/dev/null 2>&1 &&
               ! command -v qdbus >/dev/null 2>&1; then
                echo "ERROR: a Qt qdbus client is required to initialize secure KWallet storage."
                exit 1
            fi
        elif ! command -v secret-tool >/dev/null 2>&1; then
            echo "ERROR: secret-tool/libsecret is required for secure credential storage."
            echo "For headless systems only, explicitly set PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file."
            exit 1
        fi
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        echo "ERROR: Python 3 is required for the system tray."
        exit 1
    fi
    if ! command -v sqlite3 >/dev/null 2>&1; then
        echo "ERROR: sqlite3 is required by the launcher and maintenance commands."
        exit 1
    fi
    if ! command -v fusermount3 >/dev/null 2>&1; then
        echo "ERROR: FUSE 3 userspace tools (fusermount3) are required."
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

    if [ ! -f "$RELEASE_BINARY" ]; then
        echo "ERROR: Build failed to produce binary at ${RELEASE_BINARY}"
        exit 1
    fi
    chmod +x "$RELEASE_BINARY"
    echo "Build complete."
}

_install_release() {
    RELEASE_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "${SCRIPT_DIR}/package.json")"
    RELEASE_HASH="$(
        sha256sum \
            "${SCRIPT_DIR}/release/proton-sync.js" \
            "${SCRIPT_DIR}/release/drive-fuse-sidecar" \
            "${SCRIPT_DIR}/bun.lockb" |
            sha256sum |
            cut -c1-12
    )"
    INSTALL_DIR="${INSTALL_BASE}/${RELEASE_VERSION}-${RELEASE_HASH}"
    mkdir -p "${INSTALL_BASE}"

    if [ ! -d "$INSTALL_DIR" ]; then
        STAGING_DIR="${INSTALL_DIR}.staging-$$"
        mkdir -m 700 "$STAGING_DIR"
        cp "${SCRIPT_DIR}/release/proton-sync" "${SCRIPT_DIR}/release/proton-sync.js" "$STAGING_DIR/"
        cp -R "${SCRIPT_DIR}/release/node_modules" "$STAGING_DIR/"
        if [ -f "${SCRIPT_DIR}/release/drive-fuse-sidecar" ]; then
            cp "${SCRIPT_DIR}/release/drive-fuse-sidecar" "$STAGING_DIR/"
        fi
        chmod 755 "$STAGING_DIR/proton-sync"
        chmod 644 "$STAGING_DIR/proton-sync.js"
        [ ! -f "$STAGING_DIR/drive-fuse-sidecar" ] || chmod 755 "$STAGING_DIR/drive-fuse-sidecar"
        mv "$STAGING_DIR" "$INSTALL_DIR"
    fi

    OLD_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
    if [ -n "$OLD_RELEASE" ] && [ "$OLD_RELEASE" != "$INSTALL_DIR" ]; then
        ln -sfn "$OLD_RELEASE" "${PREVIOUS_LINK}.new"
        mv -Tf "${PREVIOUS_LINK}.new" "$PREVIOUS_LINK"
    fi
    ln -sfn "$INSTALL_DIR" "${CURRENT_LINK}.new"
    mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
    echo "Installed immutable release: $INSTALL_DIR"
}

_rollback_release() {
    ROLLBACK_TARGET="$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)"
    if [ -z "$ROLLBACK_TARGET" ] || [ ! -d "$ROLLBACK_TARGET" ]; then
        return 1
    fi
    ln -sfn "$ROLLBACK_TARGET" "${CURRENT_LINK}.rollback"
    mv -Tf "${CURRENT_LINK}.rollback" "$CURRENT_LINK"
    echo "Rolled back to: $ROLLBACK_TARGET"
}

# ── --rebuild flag handling ────────────────────────────────────────────────
if [ "$FORCE_REBUILD" -eq 1 ]; then
    echo "============================================="
    echo "    Proton Drive Linux — Rebuilding"
    echo "============================================="
    _do_build
    _install_release
    if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        echo "Restarting daemon (systemd) to pick up newly built binary..."
        if ! systemctl --user restart "$SERVICE_NAME"; then
            echo "New release failed to restart; attempting rollback."
            _rollback_release
            systemctl --user restart "$SERVICE_NAME"
            exit 1
        fi
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
_install_release

# Install the daemon service. The desktop session owns the tray separately.
mkdir -p "${SYSTEMD_DIR}"
cat <<EOF > "$SERVICE_DST"
[Unit]
Description=Drive for Linux core (unofficial Proton client)
After=network-online.target graphical-session.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${BINARY}
WorkingDirectory=${CURRENT_LINK}
Restart=on-failure
RestartSec=3s
TimeoutStopSec=20s
KillMode=control-group
Environment=PATH=${PATH}
UMask=0077
PrivateTmp=true
NoNewPrivileges=true
LockPersonality=true
RestrictRealtime=true
ProtectClock=true
ProtectControlGroups=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
SystemCallArchitectures=native
LimitNOFILE=65536
MemoryHigh=1G
OOMPolicy=stop

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
systemctl --user disable --now "$LEGACY_SERVICE_NAME" 2>/dev/null || true
if ! systemctl --user enable --now "$SERVICE_NAME"; then
    echo "New service failed to start; attempting release rollback."
    _rollback_release
    systemctl --user restart "$SERVICE_NAME" 2>/dev/null || true
    exit 1
fi

echo ""
echo "============================================="
echo "  Setup complete!"
echo "  Daemon service is enabled and running."
echo "  Dashboard will be at:      http://localhost:8085"
echo "============================================="
