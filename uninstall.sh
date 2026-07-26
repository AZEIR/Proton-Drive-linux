#!/bin/bash
# Proton Drive Linux — Uninstall Script

SERVICE_NAME="proton-sync.service"
SYSTEMD_DIR="${HOME}/.config/systemd/user"
SERVICE_PATH="${SYSTEMD_DIR}/${SERVICE_NAME}"
AUTOSTART_PATH="${HOME}/.config/autostart/proton-drive-tray.desktop"

echo "============================================="
echo "    Proton Drive Linux — Uninstall"
echo "============================================="

echo "Stopping daemon and tray processes..."
pkill -f "proton-sync" 2>/dev/null || true
pkill -f "proton-drive-tray.py" 2>/dev/null || true

if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Stopping systemd service..."
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
fi

if systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "Disabling systemd service..."
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
fi

if [ -f "$SERVICE_PATH" ]; then
    echo "Removing systemd unit file..."
    rm -f "$SERVICE_PATH"
fi

if [ -f "$AUTOSTART_PATH" ]; then
    echo "Removing desktop autostart entry..."
    rm -f "$AUTOSTART_PATH"
fi

systemctl --user daemon-reload 2>/dev/null || true

echo ""
echo "============================================="
echo "  Uninstall complete!"
echo "  Systemd service and autostart tray removed."
echo "  Your local sync folder was left untouched."
echo "============================================="
