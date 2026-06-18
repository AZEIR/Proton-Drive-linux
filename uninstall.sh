#!/bin/bash
# Proton Drive Linux — uninstall script
# Stops and removes the systemd user service installed by setup.sh.

SERVICE_NAME="proton-sync.service"
SYSTEMD_DIR="${HOME}/.config/systemd/user"
SERVICE_DST="${SYSTEMD_DIR}/${SERVICE_NAME}"

echo "============================================="
echo "    Proton Drive Linux — Uninstall"
echo "============================================="

# Stop and disable the service if it is managed by systemd
if systemctl --user list-unit-files "$SERVICE_NAME" 2>/dev/null | grep -q "$SERVICE_NAME"; then
    echo "Stopping and disabling ${SERVICE_NAME}..."
    systemctl --user stop    "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
fi

# Remove the service file
if [ -f "$SERVICE_DST" ]; then
    rm -f "$SERVICE_DST"
    echo "Removed: ${SERVICE_DST}"
fi

systemctl --user daemon-reload

echo ""
echo "Proton Drive systemd service removed."
echo "Your sync folder and local data were NOT deleted."
echo ""
echo "To clean sync state as well, run: ./drive.sh reset"
echo "============================================="
