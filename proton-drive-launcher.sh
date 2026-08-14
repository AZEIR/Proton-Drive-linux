#!/bin/bash
# Proton Drive Linux — compatibility launcher.
#
# The daemon must be the service's foreground process so it receives exactly
# one shutdown signal and remains the sole owner of the FUSE lifecycle. The
# graphical tray is started separately by the desktop autostart entry.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_BIN="${SCRIPT_DIR}/release/proton-sync"

exec "$DAEMON_BIN"
