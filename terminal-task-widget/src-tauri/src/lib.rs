use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                let open_i = MenuItem::with_id(app, "open", "Open Panel", true, None::<&str>)?;
                let hide_i = MenuItem::with_id(app, "hide", "Hide to Ball", true, None::<&str>)?;
                let reset_i =
                    MenuItem::with_id(app, "reset", "Reset Position", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(app)?;
                let quit_i =
                    MenuItem::with_id(app, "quit", "Quit Terminal Task", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open_i, &hide_i, &reset_i, &sep, &quit_i])?;

                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("Terminal Task")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                            }
                            let _ = app.emit("tray:open", ());
                        }
                        "hide" => {
                            let _ = app.emit("tray:hide", ());
                        }
                        "reset" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                            }
                            let _ = app.emit("tray:reset", ());
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        // Left-click on the tray icon toggles the panel
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                            }
                            let _ = app.emit("tray:toggle", ());
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
