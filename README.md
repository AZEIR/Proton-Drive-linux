# Drive for Linux

> An unofficial Proton Drive Linux sync client built using the [Official Proton Drive SDK](https://github.com/ProtonDriveApps/sdk) in compliance with [Proton SDK Guidelines](https://github.com/ProtonDriveApps/sdk#usage-guidelines-for-personal-projects).

<img width="2880" height="1525" alt="image" src="https://github.com/user-attachments/assets/aabc9eec-3e09-401f-8273-188566932d58" />

This is a personal project built because Proton doesn't have an official Linux client. It's designed to work like the Windows version: install it, forget about it, and your files stay in sync.

---

## What it does

It runs a background daemon that keeps a local folder on your computer in sync with your Proton Drive cloud. Both directions — changes you make locally show up in the cloud, and changes you make in the web app or on another device show up locally.

**The daemon starts on login automatically** (via systemd) and runs silently in the background.

---

## Getting started

### 1. Clone with Submodules

```bash
git clone --recursive https://github.com/AZEIR/Proton-Drive-linux.git
cd Proton-Drive-linux
```
*(If you already cloned without submodules, run `git submodule update --init sdk`. Do not initialize the SDK's unrelated nested platform submodules.)*

### 2. Install Node 22, Rust, FUSE 3/libsecret, and [Bun](https://bun.sh)

```bash
curl -fsSL https://bun.sh/install | bash
```

### 3. Run setup

```bash
./setup.sh
```

This builds an immutable, versioned release under
`~/.local/lib/drive-for-linux`, installs the hardened `drive-core.service`,
and installs the system tray icon. Failed upgrades automatically roll back to
the previous release.

### 4. Sign in

Once setup finishes, your browser will open the dashboard at `http://localhost:8085`. Click **Sign in with Proton** and sign in via the Proton authentication page. Once authenticated, syncing starts automatically.

A **system tray icon** also appears in your taskbar for quick access to status and controls.

> **Already set up and want to rebuild after an update?**
> ```bash
> ./setup.sh --rebuild
> ```

---

## Features

- **Two-way sync** — local changes upload, remote changes download
- **Real-time** — uses a file watcher + Proton's event stream, no polling
- **Works offline** — full-sync keeps a local copy, while FUSE preserves verified cached content and durably queues local writeback
- **Conflict handling** — if the same file is edited on two devices simultaneously, a conflict copy (`file (Conflict 2026-06-20).txt`) is created so no work is lost
- **Bulk-delete protection** — if an accidental mass deletion is detected, the daemon pauses and requests confirmation before touching the cloud
- **Web dashboard** — monitor sync status, active transfers, storage quota, activity logs, and settings at `http://localhost:8085`
- **System tray icon** — check status or open the dashboard with a click
- **Ignore rules** — create a `.protonignore` file in your sync folder (same syntax as `.gitignore`) to exclude files/folders
- **Adaptive network governor** — one bounded scheduler and aggregate bandwidth budget shared by full sync and FUSE transfers
- **Durable FUSE writeback** — local flush/close state is committed to a power-loss durable journal before background upload

### Built-in ignores (always skipped)

| Pattern | Description |
|---|---|
| `.DS_Store` | macOS metadata junk |
| `Thumbs.db`, `desktop.ini` | Windows metadata junk |
| `~*` | Office / LibreOffice lock files |
| `*.swp`, `*.swo` | Vim swap files |
| `*.tmp-*` | Proton internal temp files |

---

## Development & Testing

This project uses a decoupled architecture where the Proton Drive SDK lives in a submodule under `sdk/`.

### Run Test Suite

Run the comprehensive unit test suite covering DB mapping, Dashboard API, and Engine sync conflicts:

```bash
bun test tests/
```

---

## Day-to-day commands

All management goes through `./drive.sh`:

```bash
./drive.sh status          # Is the daemon running?
./drive.sh logs            # Tail live sync logs
./drive.sh stop            # Stop the daemon
./drive.sh start           # Start it again
./drive.sh restart         # Restart (e.g. after changing settings)
./drive.sh ui              # Open the dashboard in your browser
./drive.sh reset           # Wipe local sync database (forces a full re-sync on next start)
```

---

## Dashboard

Open `http://localhost:8085` in any browser (or run `./drive.sh ui`).

From the dashboard you can:
- View active uploads/downloads and transfer progress
- Pause and resume sync
- Force a full re-scan
- View activity log history
- Inspect storage quota
- Sign out / sign in with a different account
- Change local sync folder path

---

## Custom ignore rules

Create a file called `.protonignore` in your sync root folder:

```
# Ignore a specific folder
node_modules/

# Ignore all log files
*.log

# Ignore a specific file
secrets.env

# Un-ignore something that default rules block
!.git/
```

---

## Uninstall

```bash
./uninstall.sh
```

Stops the service, removes the systemd unit, and removes the tray icon. Your local sync folder is left untouched.

---

## Requirements

- Linux (x86_64)
- [Bun](https://bun.sh) (for building)
- Node.js 22 or newer (runtime)
- Rust 1.85+ and FUSE 3 development headers (native sidecar build)
- Secret Service/libsecret (`secret-tool`) for the default credential store
- Python 3 with GTK/AppIndicator bindings (system tray)
- SQLite 3 command-line tools
- FUSE 3 userspace tools (`fusermount3`)
- A C/C++ build toolchain if prebuilt native modules are unavailable

---

## Limitations & known issues

- Unofficial client — not affiliated with Proton AG
- Only tested on x86_64 Linux (ARM untested)
- Very large files (multi-GB) stream directly (same as web app)
- The new Rust FUSE 3 sidecar is experimental and is not selected by default until its metadata/cache IPC and crash-injection gates are complete

For a headless machine without Secret Service, plaintext credential persistence
is available only by explicitly setting
`PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file`. The containing directory is
restricted to `0700` and the atomically-written session file to `0600`.

---

## Disclaimer

This is an unofficial, personal project. Use it at your own risk. Always keep important files backed up.

---

## AI declaration

This project was built with AI coding assistance from Claude, Gemini, and Google DeepMind Antigravity.
