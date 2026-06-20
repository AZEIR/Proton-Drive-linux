# Proton Drive Linux

> An unofficial Proton Drive Linux sync client using offical SDK.

<img width="2880" height="1525" alt="image" src="https://github.com/user-attachments/assets/aabc9eec-3e09-401f-8273-188566932d58" />

This is a personal project. I'm not a professional developer — I built this because Proton doesn't have an official Linux client and I needed one that works like the Windows version does: install it, forget about it, files just stay in sync.

---

## What it does

It runs a background daemon that keeps a local folder on your computer in sync with your Proton Drive cloud. Both directions — changes you make locally show up in the cloud, and changes you make in the web app or on another device show up locally.

**The daemon starts on login automatically** (via systemd) and runs silently in the background. You don't have to think about it.

---

## Getting started

### 1. Install [Bun](https://bun.sh) (required to build)

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Run setup

```bash
./setup.sh
```

This builds the sync binary, installs it as a systemd service that auto-starts on login, installs the system tray icon, and asks you which local folder to sync to (default: `~/P-Drive`).

### 3. Sign in

Once setup finishes, your browser will open the dashboard at `http://localhost:8085`. If you are not yet signed in, the dashboard shows a login screen — click **Sign in with Proton** and it will open a Proton authentication page in your browser. Sign in there, come back, and syncing starts automatically.

A **system tray icon** also appears in your taskbar. You can use it to open the dashboard, pause sync, or check status without opening a terminal.

That's it. Your files sync in the background from now on.

> **Already set up and want to rebuild after an update?**
> ```bash
> ./setup.sh --rebuild
> ```

---

## Features

- **Two-way sync** — local changes upload, remote changes download
- **Real-time** — uses a file watcher + Proton's event stream, no polling
- **Works offline** — keeps a full local copy; queued changes sync when you reconnect
- **Conflict handling** — if the same file is edited on two devices simultaneously, the older version becomes a conflict copy (`file (Conflict 2026-06-20).txt`) instead of losing your work
- **Bulk-delete protection** — if something looks like an accidental mass wipe (e.g. wrong folder deleted, empty sync folder), the daemon pauses and asks you to confirm before touching the cloud
- **Web dashboard** — see sync status, active transfers, storage quota, activity log, pause/resume, and settings at `http://localhost:8085`
- **System tray icon** — shows sync state and lets you open the dashboard without opening a terminal
- **Ignore rules** — create a `.protonignore` file in your sync folder (same syntax as `.gitignore`) to exclude files/folders from syncing

### Built-in ignores (always skipped, no configuration needed)

| Pattern | What it is |
|---|---|
| `.DS_Store` | macOS metadata junk |
| `Thumbs.db`, `desktop.ini` | Windows metadata junk |
| `~*` | Office / LibreOffice lock files |
| `*.swp`, `*.swo` | Vim swap files |
| `*.tmp-*` | Proton internal temp files |

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
- See what's currently uploading or downloading and the progress
- Pause and resume sync
- Force a full re-scan
- View the recent activity log (what was uploaded, downloaded, renamed, deleted)
- See your storage quota
- Sign out / sign in with a different account
- Change the local sync folder path

---

## Custom ignore rules

Create a file called `.protonignore` in your sync root folder. It works like `.gitignore`:

```
# Ignore a specific folder
node_modules/

# Ignore all log files
*.log

# Ignore a specific file
secrets.env

# Un-ignore something that the defaults would block
!.git/
```

The daemon picks up changes to `.protonignore` automatically — no restart needed.

---

## Uninstall

```bash
./uninstall.sh
```

This stops the service, removes the systemd unit, and removes the tray icon. Your local sync folder and the files in it are left untouched.

---

## Requirements

- Linux (x86_64)
- [Bun](https://bun.sh) — only needed for the initial build

---

## Roadmap

- **File-On-Demand (FUSE) mode** — instead of downloading everything, files are listed locally but only downloaded when you open them. Planned, not yet working.
- **AppImage** — a self-contained single file you can double-click to install with no terminal needed. Planned.

---

## Limitations & known issues

- This is an unofficial client and is not affiliated with Proton AG in any way
- Only tested on x86_64 Linux. ARM is untested
- Very large files (multi-GB) may take a while — the upload streams the full file, same as the web app
- FUSE / File-On-Demand mode is currently broken — use Full Sync (the default) for now

---

## Disclaimer

This is an unofficial, personal project. Use it at your own risk. Always keep important files backed up.

I've tested this pretty hard including accidentally nuking my entire Proton Drive folder. It's working fine for my daily use, but I can't guarantee it'll work perfectly for everyone.

---

## AI declaration

This project was built with AI coding assistance from Claude and Gemini. As a non-developer, I couldn't have built this without them.
