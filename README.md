# Proton Drive Linux Sync Client

A fully featured, offline-first, two-way sync client daemon for Proton Drive on Linux, resembling the behavior of the official Windows client. 

<img width="2880" height="1525" alt="Screenshot_20260617_113416" src="https://github.com/user-attachments/assets/353b755f-cc6d-4371-88b1-63d9fc736daa" />

It runs a background synchronization daemon that keeps a local directory in sync with your Proton Drive cloud, and exposes a beautiful web-based dashboard UI locally.

## Features

- **Offline Folder Workable**: Keeps a full copy of your cloud files locally so you can view, edit, and create files offline.
- **Two-Way Autosync**: Incremental remote events listener and local file watcher (`chokidar`) ensure changes propagate both ways instantly.
- **Double-Guard Loop Protection**: Utilizes a local SQLite database to map file revision UIDs, sizes, and mtimes, preventing infinite sync loops.
- **Conflict Handling**: Safely resolves edit conflicts by creating conflict copies (`filename (Conflict <timestamp>).ext`) instead of overwriting edits.
- **Web Dashboard**: An ultra-premium, modern dark-mode glassmorphism interface to monitor status, storage quota, activity logs, and configure settings.
- **Systemd Integration**: Can be registered as a user service to autostart silently on Linux boot.

---

> [!WARNING]
> **File-On-Demand (FUSE) Mode is currently broken.** Please use the default **Full Sync Mode** (`PROTON_SYNC_MODE=full`) for synchronization.

## Getting Started

### 1. Initial Authentication
Authenticate your Proton account:
```bash
./drive.sh login
```
*This will launch Proton Drive authentication in your browser to securely store session keys in your OS keyring.*

### 2. Run the Sync Daemon
Control the background synchronization service:
- **Start the sync daemon**:
  ```bash
  ./drive.sh start
  ```
- **Check the daemon status**:
  ```bash
  ./drive.sh status
  ```
- **Stop the daemon**:
  ```bash
  ./drive.sh stop
  ```

### 3. Open the Dashboard UI
Access the premium interface:
👉 **[http://localhost:8085](http://localhost:8085)**

You can also launch it directly from the CLI:
```bash
./drive.sh ui
```

From the UI, you can monitor quota usage, pause/resume sync, force a manual sync, and configure custom folder paths.

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

---

## Disclaimer

This is an unofficial, community-led client project. It is not affiliated with, sponsored by, or endorsed by Proton AG. All trademarks and product names are the property of their respective owners.
