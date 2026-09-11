use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri::{LogicalPosition, LogicalSize, Runtime, WebviewWindow};

// Kept in step with BALL and dockPoint() in src/App.tsx. Duplicated on purpose:
// the whole point of the recovery path below is that it must work when the
// frontend is not running, so it cannot ask JS for these.
#[cfg(desktop)]
const BALL: f64 = 60.0;

/// The canonical dock spot — right edge of the work area, 38.2% down —
/// computed entirely in Rust.
///
/// Mirrors `dockPoint()` in App.tsx, including the fallback from the current
/// monitor to the primary one. Returns logical pixels. `None` means the OS
/// would not name a monitor at all, in which case the caller leaves the window
/// where it is rather than guessing (0,0) and parking it on the wrong screen.
#[cfg(desktop)]
fn dock_point<R: Runtime>(w: &WebviewWindow<R>) -> Option<(f64, f64)> {
    let mon = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten())?;
    let sf = mon.scale_factor();
    if !sf.is_finite() || sf <= 0.0 {
        return None;
    }
    let wa = mon.work_area();
    let x = wa.position.x as f64 / sf;
    let y = wa.position.y as f64 / sf;
    let width = wa.size.width as f64 / sf;
    let height = wa.size.height as f64 / sf;
    Some(((x + width - BALL).round(), (y + height * 0.382).round()))
}

/// Pull the window back inside the work area. Mirrors `clampBall()` in App.tsx.
///
/// Runs on the tray paths that deliberately do NOT re-dock, because the frontend
/// reads this position and builds on it: `expandPanel` places the 400x600 panel
/// from wherever the window currently is, three round-trips before it flips
/// `modeRef`. A ball left stranded outside the work area therefore grows into a
/// panel that is mostly off-screen — and "stranded outside the work area" is
/// precisely the situation the tray recovery exists for.
///
/// Doing it here removes the cause instead of racing it: by the time either
/// frontend chain looks, the position is already legal.
#[cfg(desktop)]
fn clamp_into_work_area<R: Runtime>(w: &WebviewWindow<R>) {
    let Some(mon) = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten())
    else {
        return;
    };
    let sf = mon.scale_factor();
    if !sf.is_finite() || sf <= 0.0 {
        return;
    }
    let wa = mon.work_area();
    let (wax, way) = (wa.position.x as f64 / sf, wa.position.y as f64 / sf);
    let (waw, wah) = (wa.size.width as f64 / sf, wa.size.height as f64 / sf);

    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
        return;
    };
    let (x, y) = (pos.x as f64 / sf, pos.y as f64 / sf);
    let (ww, wh) = (size.width as f64 / sf, size.height as f64 / sf);

    // Clamp the far edge first, then the near one, so a window wider than the
    // work area lands at the origin rather than off the left/top.
    let nx = x.min(wax + waw - ww).max(wax);
    let ny = y.min(way + wah - wh).max(way);
    if (nx - x).abs() > 1.0 || (ny - y).abs() > 1.0 {
        let _ = w.set_position(LogicalPosition::new(nx.round(), ny.round()));
    }
}

/// Drag the window back onto the screen WITHOUT any help from the frontend.
///
/// This exists because `show()` alone cannot recover the case that actually
/// bites: after a long standby or hibernate, the window can come back still
/// flagged `WS_VISIBLE` but behind everything, or with a dead composition
/// surface. `show()` is `ShowWindow(SW_SHOW)`, which is a **no-op** on a window
/// that already has `WS_VISIBLE` — so the frontend watchdog can run every 45s
/// forever and change nothing. Dropping and re-setting always-on-top issues two
/// real `SetWindowPos` calls and forces Windows to re-apply the z-order.
///
/// Every step is best-effort and independent: one failing IPC call must not
/// skip the ones after it (the frontend watchdog's bug, which wraps the whole
/// body in a single `try` with `show()` last).
///
/// `redock` also restores the 60x60 ball geometry. Pass `false` when the
/// frontend is about to size the window itself (opening the panel).
#[cfg(desktop)]
fn force_restore<R: Runtime>(w: &WebviewWindow<R>, redock: bool) {
    // A minimized window ignores show() until it is restored.
    let _ = w.unminimize();
    let _ = w.show();

    // The load-bearing pair. Order matters: NOTOPMOST then TOPMOST, so Windows
    // re-applies the flag instead of short-circuiting an unchanged value.
    let _ = w.set_always_on_top(false);
    let _ = w.set_always_on_top(true);

    if redock {
        let _ = w.set_size(LogicalSize::new(BALL, BALL));
        if let Some((x, y)) = dock_point(w) {
            let _ = w.set_position(LogicalPosition::new(x, y));
        }
    } else {
        // Not re-docking is not the same as leaving it anywhere: see
        // clamp_into_work_area.
        clamp_into_work_area(w);
    }

    // SetForegroundWindow is the strongest available "come to the front", and
    // a tray click gives the process the foreground rights to make it stick.
    let _ = w.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // MUST be the first plugin registered — the plugin's own documentation is
    // explicit about it, so that it runs before anything else can interfere.
    //
    // What it buys, beyond the obvious: relaunching the exe is what a user
    // actually does when the ball has vanished, and until now that started a
    // SECOND copy. Both copies share one WebView2 profile and therefore one
    // geek-hotkey, so the newcomer would fail to claim the hotkey the original
    // still held, and (before the fix in App.tsx) persist a fallback over the
    // user's own binding. Now that same relaunch is delivered to the surviving
    // process as a repair request instead.
    //
    // Deliberately force_restore only, not reload: the common accidental case
    // is autostart having already launched it and the user clicking the desktop
    // shortcut out of habit, and that must not throw away an open editor. A
    // genuinely dead webview is one click away on the tray's Restart UI.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            force_restore(&w, true);
        }
    }));

    let builder = builder
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
                let reload_i =
                    MenuItem::with_id(app, "reload", "Restart UI", true, None::<&str>)?;
                let restart_i =
                    MenuItem::with_id(app, "restart", "Restart App", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(app)?;
                let sep2 = PredefinedMenuItem::separator(app)?;
                let quit_i =
                    MenuItem::with_id(app, "quit", "Quit Terminal Task", true, None::<&str>)?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &open_i, &hide_i, &reset_i, &sep, &reload_i, &restart_i, &sep2, &quit_i,
                    ],
                )?;

                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip("Terminal Task")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        // Each arm does the Rust-side recovery FIRST, then emits
                        // to the frontend. If the webview is suspended or dead,
                        // the emit goes nowhere and the Rust half is all that
                        // runs — which is exactly the case this is here for.
                        "open" => {
                            if let Some(w) = app.get_webview_window("main") {
                                // No redock: the frontend is about to grow the
                                // window to the 400x600 panel itself.
                                force_restore(&w, false);
                            }
                            let _ = app.emit("tray:open", ());
                        }
                        "hide" => {
                            let _ = app.emit("tray:hide", ());
                        }
                        "reset" => {
                            if let Some(w) = app.get_webview_window("main") {
                                force_restore(&w, true);
                            }
                            let _ = app.emit("tray:reset", ());
                        }
                        // Last resort, for when the webview process itself is
                        // gone: reload the frontend rather than the whole app.
                        // Task data is safe — it lives in localStorage and the
                        // disk mirror, and the boot path restores from either.
                        "reload" => {
                            if let Some(w) = app.get_webview_window("main") {
                                force_restore(&w, true);
                                let _ = w.reload();
                            }
                        }
                        // The guaranteed one. Reported 2026-09-11: all three
                        // of the original items failed and only relaunching the
                        // exe worked, which is the signature of a webview that
                        // is gone rather than merely hidden. This is that
                        // relaunch, one click instead of hunting for the exe.
                        // Safe to use at any time: tasks live in localStorage
                        // and in the 800ms-debounced mirror at
                        // Documents/TerminalTasks/state.json, and boot restores
                        // from the mirror when localStorage comes back empty.
                        "restart" => {
                            app.restart();
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
                                force_restore(&w, false);
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
