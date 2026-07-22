use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Spawn the proton-sync sidecar binary automatically
            if let Ok(sidecar_command) = app.shell().sidecar("proton-sync") {
                let _ = sidecar_command.spawn();
            }

            // Build system tray menu items
            let open_item = MenuItemBuilder::with_id("open_dashboard", "Open Dashboard").build(app)?;
            let restart_item = MenuItemBuilder::with_id("restart_service", "Restart Service").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Proton Drive").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&open_item)
                .separator()
                .item(&restart_item)
                .item(&quit_item)
                .build()?;

            if let Some(icon) = app.default_window_icon() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon.clone())
                    .menu(&menu)
                    .on_menu_event(|app_handle, event| match event.id.as_ref() {
                        "open_dashboard" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "restart_service" => {
                            let _ = app_handle.restart();
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app_handle = tray.app_handle();
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Intercept close button to hide window to tray instead of quitting
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
