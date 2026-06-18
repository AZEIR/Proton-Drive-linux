#!/usr/bin/env python3
import os
import subprocess
import sys
import time
import threading
import webbrowser
import requests

import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib

# Read environment variables
PORT = int(os.environ.get("PROTON_SYNC_PORT", "8085"))
STATUS_URL = f"http://localhost:{PORT}/api/status"

# Set up icon paths
BASE_DIR = os.path.dirname(os.path.realpath(__file__))
ICONS_DIR = os.path.join(BASE_DIR, "src-tauri", "icons")

# Try to import AppIndicator
has_indicator = False
try:
    gi.require_version('AppIndicator3', '0.1')
    from gi.repository import AppIndicator3 as appindicator
    has_indicator = True
except (ImportError, ValueError):
    try:
        gi.require_version('AyatanaAppIndicator3', '0.1')
        from gi.repository import AyatanaAppIndicator3 as appindicator
        has_indicator = True
    except (ImportError, ValueError):
        print("AppIndicator3 or AyatanaAppIndicator3 not found. Falling back to Gtk.StatusIcon (deprecated).", file=sys.stderr)

class ProtonDriveTrayApp:
    def __init__(self):
        self.stop_flag = threading.Event()
        self.current_status = "unknown"
        self.current_mode = "full"
        
        # Build Context Menu
        self.menu = Gtk.Menu()
        
        self.menu_open_dash = Gtk.MenuItem(label="Open Dashboard")
        self.menu_open_dash.connect("activate", self.open_dashboard)
        self.menu.append(self.menu_open_dash)
        
        self.menu_open_folder = Gtk.MenuItem(label="Open Sync Folder")
        self.menu_open_folder.connect("activate", self.open_folder)
        self.menu.append(self.menu_open_folder)
        
        self.menu.append(Gtk.SeparatorMenuItem())
        
        self.menu_sync = Gtk.MenuItem(label="Sync Now")
        self.menu_sync.connect("activate", self.sync_now)
        self.menu.append(self.menu_sync)
        
        self.menu_pause = Gtk.MenuItem(label="Pause Sync")
        self.menu_pause.connect("activate", self.pause_sync)
        self.menu.append(self.menu_pause)
        
        self.menu_resume = Gtk.MenuItem(label="Resume Sync")
        self.menu_resume.connect("activate", self.resume_sync)
        self.menu.append(self.menu_resume)
        
        self.menu.append(Gtk.SeparatorMenuItem())
        
        self.menu_stop_daemon = Gtk.MenuItem(label="Stop Daemon")
        self.menu_stop_daemon.connect("activate", self.stop_daemon)
        self.menu.append(self.menu_stop_daemon)

        self.menu.append(Gtk.SeparatorMenuItem())

        self.menu_exit = Gtk.MenuItem(label="Exit Tray")
        self.menu_exit.connect("activate", self.quit_app)
        self.menu.append(self.menu_exit)
        
        self.menu.show_all()
        
        # Set up tray representation
        if has_indicator:
            self.indicator = appindicator.Indicator.new(
                "proton_drive_sync_tray",
                "tray-synced",
                appindicator.IndicatorCategory.APPLICATION_STATUS
            )
            self.indicator.set_status(appindicator.IndicatorStatus.ACTIVE)
            self.indicator.set_icon_theme_path(ICONS_DIR)
            self.indicator.set_menu(self.menu)
            self.indicator.set_title("Proton Drive")
        else:
            self.status_icon = Gtk.StatusIcon()
            self.status_icon.set_from_file(os.path.join(ICONS_DIR, "tray-synced.png"))
            self.status_icon.set_title("Proton Drive")
            self.status_icon.connect("popup-menu", self.popup_menu_fallback)
            self.status_icon.connect("activate", self.open_dashboard)
            self.status_icon.set_visible(True)

        # Start background update thread
        self.update_thread = threading.Thread(target=self.status_polling_loop, daemon=True)
        self.update_thread.start()

    def popup_menu_fallback(self, icon, button, activate_time):
        self.menu.popup(None, None, None, self.status_icon, button, activate_time)

    def status_polling_loop(self):
        while not self.stop_flag.is_set():
            status = "offline"
            email = ""
            mode = "full"
            try:
                r = requests.get(STATUS_URL, timeout=2)
                if r.status_code == 200:
                    data = r.json()
                    status = data.get("status", "unknown")
                    email = data.get("email", "")
                    mode = data.get("mode", "full")
                else:
                    status = "error"
            except Exception:
                status = "offline"

            GLib.idle_add(self.update_ui, status, email, mode)
            time.sleep(2)

    def update_ui(self, status, email, mode):
        self.current_status = status
        self.current_mode = mode
        
        # Select icon
        icon_name = "tray-synced"
        if status in ("synced", "idle"):
            icon_name = "tray-synced"
        elif status in ("syncing", "scanning", "uploading", "downloading"):
            icon_name = "tray-syncing"
        elif status == "paused":
            icon_name = "tray-paused"
        else:
            # error, auth_required, offline, unknown
            icon_name = "tray-error"

        # Update icon path/name
        if has_indicator:
            self.indicator.set_icon_full(icon_name, f"Proton Drive: {status}")
        else:
            self.status_icon.set_from_file(os.path.join(ICONS_DIR, f"{icon_name}.png"))

        # Setup Tooltip (Gtk.StatusIcon only)
        tooltip = f"Proton Drive: {status.capitalize()}"
        if email and email != "Not Logged In":
            tooltip += f"\nAccount: {email}"
        if not has_indicator:
            self.status_icon.set_tooltip_text(tooltip)

        # Update MenuItem sensitivities
        is_running = status not in ("offline", "error", "auth_required")
        is_paused = (status == "paused")
        
        self.menu_pause.set_sensitive(is_running and not is_paused)
        self.menu_resume.set_sensitive(is_running and is_paused)
        self.menu_sync.set_sensitive(is_running and not is_paused and mode == "full")
        self.menu_open_folder.set_sensitive(is_running)
        self.menu_stop_daemon.set_sensitive(is_running)

    # Context Menu Callbacks
    def open_dashboard(self, widget):
        webbrowser.open(f"http://localhost:{PORT}")

    def open_folder(self, widget):
        self.async_post("/api/open-folder")

    def sync_now(self, widget):
        self.async_post("/api/sync")

    def pause_sync(self, widget):
        self.async_post("/api/pause")

    def resume_sync(self, widget):
        self.async_post("/api/resume")

    def async_post(self, endpoint):
        def worker():
            try:
                requests.post(f"http://localhost:{PORT}{endpoint}", json={}, timeout=2)
            except Exception as e:
                print(f"Error calling {endpoint}: {e}", file=sys.stderr)
        threading.Thread(target=worker, daemon=True).start()

    def stop_daemon(self, widget):
        drive_sh = os.path.join(BASE_DIR, "drive.sh")
        def worker():
            try:
                subprocess.run([drive_sh, "stop"], check=False)
            except Exception as e:
                print(f"Error stopping daemon: {e}", file=sys.stderr)
        threading.Thread(target=worker, daemon=True).start()

    def quit_app(self, widget):
        self.stop_flag.set()
        Gtk.main_quit()

def main():
    # Allow KeyboardInterrupt (Ctrl+C) to terminate the Gtk main loop
    import signal
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    
    app = ProtonDriveTrayApp()
    Gtk.main()

if __name__ == "__main__":
    main()
