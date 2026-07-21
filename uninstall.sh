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
for S in "proton-sync.service" "proton-drive-tray.service"; do
    if systemctl --user list-unit-files "$S" 2>/dev/null | grep -q "$S"; then
        echo "Stopping and disabling ${S}..."
        systemctl --user stop    "$S" 2>/dev/null || true
        systemctl --user disable "$S" 2>/dev/null || true
    fi

    # Remove the service file
    if [ -f "${SYSTEMD_DIR}/${S}" ]; then
        rm -f "${SYSTEMD_DIR}/${S}"
        echo "Removed: ${SYSTEMD_DIR}/${S}"
    fi
done

systemctl --user daemon-reload

echo ""
echo "Proton Drive systemd service removed."
echo "Your sync folder and local data were NOT deleted."
echo ""
echo "To clean sync state as well, run: ./drive.sh reset"
echo "============================================="
