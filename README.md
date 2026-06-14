# Proton Drive Linux Sync Client

A fully featured, offline-first, two-way sync client daemon for Proton Drive on Linux, resembling the behavior of the official Windows client. 

It runs a background synchronization daemon that keeps a local directory in sync with your Proton Drive cloud, and exposes a beautiful web-based dashboard UI locally.

## Features

- **Offline Folder Workable**: Keeps a full copy of your cloud files locally so you can view, edit, and create files offline.
- **Two-Way Autosync**: Incremental remote events listener and local file watcher (`chokidar`) ensure changes propagate both ways instantly.
- **Double-Guard Loop Protection**: Utilizes a local SQLite database to map file revision UIDs, sizes, and mtimes, preventing infinite sync loops.
- **Conflict Handling**: Safely resolves edit conflicts by creating conflict copies (`filename (Conflict <timestamp>).ext`) instead of overwriting edits.
- **Web Dashboard**: An ultra-premium, modern dark-mode glassmorphism interface to monitor status, storage quota, activity logs, and configure settings.
- **Systemd Integration**: Can be registered as a user service to autostart silently on Linux boot.

---

## Getting Started

### 1. Initial Authentication
Authenticate your Proton account using the symlinked official CLI helper in the project root:
```bash
./proton-drive auth login
```
*This will open a browser window to securely authenticate and store session keys in your OS keyring (libsecret/GNOME Keyring).*

### 2. Run the Sync Daemon
Control the background synchronization service using the helper control script:
- **Start the sync daemon**:
  ```bash
  ./start-sync.sh start
  ```
- **Check the daemon status**:
  ```bash
  ./start-sync.sh status
  ```
- **Stop the daemon**:
  ```bash
  ./start-sync.sh stop
  ```

### 3. Open the Dashboard UI
Access the premium interface in any browser:
👉 **[http://localhost:3000](http://localhost:3000)**

From the UI, you can monitor quota usage, pause/resume sync, force a manual sync, and configure a custom folder path (e.g., if you already use `~/ProtonDrive` for rclone and want `~/ProtonDrive-sync` instead).

---

## Autostart with Systemd

To run the client in the background automatically when you log into Linux:

1. Copy the service template into your user systemd directory:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp proton-sync.service ~/.config/systemd/user/proton-sync.service
   ```
2. Reload systemd:
   ```bash
   systemctl --user daemon-reload
   ```
3. Enable and start:
   ```bash
   systemctl --user enable proton-sync.service
   systemctl --user start proton-sync.service
   ```

---

## Future Roadmap: Packaging into an AppImage / Native App

To eliminate the need for opening a browser tab at `localhost:3000`, we plan to wrap the client into a single, native Linux desktop application (**AppImage** or **Flatpak**) using **Tauri** or **Electron**:

### 1. Tauri Wrapper (Recommended)
Tauri allows building tiny, exceptionally fast desktop apps by using the system's native Webview (WebKitGTK on Linux) for the UI, and Rust/Node for backend logic.
- **Sidecar Execution**: The compiled `proton-sync` binary runs silently in the background as a Tauri sidecar.
- **System Tray Icon**: Adds a system tray icon showing sync status (green dot for synced, animated indicator for syncing) with right-click actions (Pause, Resume, Settings, Open Folder).
- **Native Window**: Spawns a dedicated frameless glassmorphic window to display the dashboard directly.
- **AppImage Bundle**: Packages the sync binary, the webview frontend assets, and dependencies into a single, self-contained `ProtonSync.AppImage` executable.

### 2. Electron / NeutralinoJS Alternative
- Spawns a Chromium-based shell loading the local web interface directly in a desktop window frame, supporting native notifications on sync completions.
