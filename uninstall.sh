#!/bin/bash
# Proton Drive Linux — Uninstall Script

SERVICE_NAMES=("drive-fuse.service" "drive-core.service" "proton-sync.service")
SYSTEMD_DIR="${HOME}/.config/systemd/user"
AUTOSTART_PATH="${HOME}/.config/autostart/proton-drive-tray.desktop"

echo "============================================="
echo "    Proton Drive Linux — Uninstall"
echo "============================================="

echo "Stopping daemon and tray processes..."
pkill -f "proton-sync" 2>/dev/null || true
pkill -f "proton-drive-tray.py" 2>/dev/null || true

for SERVICE_NAME in "${SERVICE_NAMES[@]}"; do
    systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
    SERVICE_PATH="${SYSTEMD_DIR}/${SERVICE_NAME}"
    if [ -f "$SERVICE_PATH" ]; then
        echo "Removing systemd unit file: $SERVICE_NAME"
        rm -f "$SERVICE_PATH"
    fi
    CREDENTIAL_DROPIN_DIR="${SERVICE_PATH}.d"
    CREDENTIAL_DROPIN="${CREDENTIAL_DROPIN_DIR}/credentials.conf"
    if [ -f "$CREDENTIAL_DROPIN" ]; then
        echo "Removing app-managed credential override for: $SERVICE_NAME"
        rm -f "$CREDENTIAL_DROPIN"
        rmdir "$CREDENTIAL_DROPIN_DIR" 2>/dev/null || true
    fi
done

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
