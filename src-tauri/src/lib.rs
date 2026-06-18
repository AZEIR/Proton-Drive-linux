use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use serde_json::Value;

// Embed tray icon assets at compile time
const ICON_SYNCED: &[u8] = include_bytes!("../icons/tray-synced.png");
const ICON_SYNCING: &[u8] = include_bytes!("../icons/tray-syncing.png");
const ICON_PAUSED: &[u8] = include_bytes!("../icons/tray-paused.png");
const ICON_ERROR: &[u8] = include_bytes!("../icons/tray-error.png");

// State to store the daemon process handle
struct DaemonState {
    child: Arc<Mutex<Option<Child>>>,
}

fn which_node() -> Option<String> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = std::path::Path::new(dir).join("node");
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    // Fall back to bun if node is not on path
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = std::path::Path::new(dir).join("bun");
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn start_daemon(app: &AppHandle) -> Result<Child, String> {
    let sync_mode = std::env::var("PROTON_SYNC_MODE").unwrap_or_else(|_| "full".to_string());
    let binary_name = if sync_mode == "full" { "proton-sync" } else { "proton-fuse" };

    let bin_path = app.path()
        .resource_dir()
        .map(|p| p.join(binary_name).to_string_lossy().into_owned())
        .map_err(|e| e.to_string())?;

    println!("[Tauri] Spawning sync daemon at: {}", bin_path);

    let sync_port = std::env::var("PROTON_SYNC_PORT").unwrap_or_else(|_| "8085".to_string());
    let mount_point = std::env::var("PROTON_MOUNT_POINT")
        .unwrap_or_else(|_| format!("{}/P-Drive", std::env::var("HOME").unwrap_or_default()));

    println!(
        "[Tauri] Daemon Environment: PORT={}, MODE={}, MOUNT={}",
        sync_port, sync_mode, mount_point
    );

    // Ensure the binary is executable (AppImage bundling can strip the execute bit)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin_path) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(&bin_path, perms);
        }
    }

    // Run daemon as a child process
    let mut cmd = if sync_mode == "full" {
        // Execute the native compiled binary directly
        Command::new(&bin_path)
    } else {
        // Execute the Node script using Node or Bun
        let node_bin = which_node().ok_or_else(|| "Neither 'node' nor 'bun' found on system PATH.".to_string())?;
        println!("[Tauri] Using Node binary: {}", node_bin);
        let mut c = Command::new(node_bin);
        c.arg(&bin_path);
        c
    };

    cmd.arg("--port")
       .arg(&sync_port)
       .arg("--mount-point")
       .arg(&mount_point)
       .env("PROTON_SYNC_PORT", &sync_port)
       .env("PROTON_SYNC_MODE", &sync_mode)
       .env("PROTON_MOUNT_POINT", &mount_point)
       .stdin(Stdio::null())
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn daemon: {}", e))?;
    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Force X11 backend to avoid EGL/DMABuf crashes on Wayland (works via XWayland).
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        // Prevent WebKit DMABuf renderer from attempting EGL initialisation.
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // Disable WebKit sandbox — WEBKIT_FORCE_SANDBOX was removed in newer WebKit.
        if std::env::var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS").is_err() {
            std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
        }
    }

    tauri::Builder::default()
        .manage(DaemonState {
            child: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            let app_handle = app.handle();

            // Check if "--hidden" or "--background" was passed in arguments
            let args: Vec<String> = std::env::args().collect();
            let start_hidden = args.iter().any(|arg| arg == "--hidden" || arg == "--background");

            if !start_hidden {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            // 1. Spawn the background Sync / FUSE daemon
            match start_daemon(app_handle) {
                Ok(child) => {
                    let state: State<DaemonState> = app_handle.state();
                    *state.child.lock().unwrap() = Some(child);
                    println!("[Tauri] Sync daemon spawned successfully.");
                }
                Err(err) => {
                    eprintln!("[Tauri] ERROR: Failed to start sync daemon: {}", err);
                }
            }

            // 2. Setup System Tray Menu
            let tray_menu = Menu::with_items(app_handle, &[
                &MenuItem::with_id(app_handle, "open", "Open Dashboard", true, None::<&str>)?,
                &MenuItem::with_id(app_handle, "open_folder", "Open Sync Folder", true, None::<&str>)?,
                &MenuItem::with_id(app_handle, "pause", "Pause Sync", true, None::<&str>)?,
                &MenuItem::with_id(app_handle, "resume", "Resume Sync", true, None::<&str>)?,
                &MenuItem::with_id(app_handle, "sync", "Sync Now", true, None::<&str>)?,
                &MenuItem::with_id(app_handle, "quit", "Quit", true, None::<&str>)?,
            ])?;

            // 3. Create Tray Icon
            let default_tray_icon = tauri::image::Image::from_bytes(ICON_SYNCED).unwrap();
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(default_tray_icon)
                .menu(&tray_menu)
                .tooltip("Proton Drive: Connecting...")
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "open" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "open_folder" => {
                            let _ = ureq::post("http://localhost:8085/api/open-folder").send_json(serde_json::json!({}));
                        }
                        "pause" => {
                            let _ = ureq::post("http://localhost:8085/api/pause").send_json(serde_json::json!({}));
                        }
                        "resume" => {
                            let _ = ureq::post("http://localhost:8085/api/resume").send_json(serde_json::json!({}));
                        }
                        "sync" => {
                            let _ = ureq::post("http://localhost:8085/api/sync").send_json(serde_json::json!({}));
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app_handle)?;

            // 4. Setup Window Events (intercept close request to hide the window to keep the client running in tray)
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            // 5. Spawn dynamic status/icon monitor thread
            let app_handle_clone = app_handle.clone();
            thread::spawn(move || {
                let tray = match app_handle_clone.tray_by_id("main-tray") {
                    Some(t) => t,
                    None => return,
                };

                let img_synced = tauri::image::Image::from_bytes(ICON_SYNCED).unwrap();
                let img_syncing = tauri::image::Image::from_bytes(ICON_SYNCING).unwrap();
                let img_paused = tauri::image::Image::from_bytes(ICON_PAUSED).unwrap();
                let img_error = tauri::image::Image::from_bytes(ICON_ERROR).unwrap();

                let mut current_status = String::new();

                loop {
                    thread::sleep(Duration::from_secs(2));

                    let sync_port = std::env::var("PROTON_SYNC_PORT").unwrap_or_else(|_| "8085".to_string());
                    let url = format!("http://localhost:{}/api/status", sync_port);

                    let status = match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
                        Ok(res) => {
                            if let Ok(Value::Object(map)) = res.into_json::<Value>() {
                                map.get("status")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| "unknown".to_string())
                            } else {
                                "unknown".to_string()
                            }
                        }
                        Err(_) => "offline".to_string(),
                    };

                    if status == "auth_required" && current_status != "auth_required" {
                        if let Some(win) = app_handle_clone.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }

                    if status == current_status {
                        continue;
                    }

                    current_status = status.clone();

                    let new_icon = match current_status.as_str() {
                        "synced" | "idle" => &img_synced,
                        "syncing" | "scanning" | "uploading" | "downloading" => &img_syncing,
                        "paused" => &img_paused,
                        "error" | "auth_required" | "offline" => &img_error,
                        _ => &img_synced,
                    };

                    let _ = tray.set_icon(Some(new_icon.clone()));
                    let tooltip = format!("Proton Drive: {}", current_status);
                    let _ = tray.set_tooltip(Some(tooltip));
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // Terminate child sync daemon process when Tauri exits
                let state: State<DaemonState> = app_handle.state();
                let mut child_guard = state.child.lock().unwrap();
                if let Some(mut child) = child_guard.take() {
                    println!("[Tauri] Terminating background sync daemon...");
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
