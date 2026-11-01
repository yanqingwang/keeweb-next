#[cfg(desktop)]
pub mod browser_bridge;

#[cfg(desktop)]
#[path = "browser_socket.rs"]
pub mod browser_socket;

#[cfg(mobile)]
mod browser_bridge {
    use serde_json::Value;

    pub struct BrowserState;

    impl BrowserState {
        pub fn new(_replies: std::sync::Arc<crate::Replies>) -> Self {
            Self
        }
    }

    #[tauri::command]
    pub fn browser_rpc_reply(
        _reply: crate::RpcReply,
    ) -> Result<(), String> {
        Err("native messaging is only supported on desktop".to_string())
    }

    #[tauri::command]
    pub fn set_browser_integration(_enabled: bool) {}

    #[allow(dead_code)]
    fn _unused(_: Option<Value>) {}
}
pub mod config_store;
mod fs_ops;
pub mod webdav;
use std::collections::HashMap;
use std::sync::mpsc;
use tauri::Manager;

use webdav::{WebDavRequest, WebDavResponse};

/// Talks to a WebDAV server for the web UI.
///
/// The browser build has to use XHR, which the browser subjects to CORS;
/// WebDAV servers such as Nutstore (dav.jianguoyun.com) do not send the
/// headers that would allow it. The webview shell sends the same request
/// through reqwest instead, so a database on WebDAV can be opened and saved
/// without a proxy.
#[tauri::command]
async fn webdav_request(request: WebDavRequest) -> Result<WebDavResponse, String> {
    webdav::perform(request).await
}

/// A reply from the webview to a native-messaging request.
#[derive(Debug, serde::Deserialize)]
pub struct RpcReply {
    pub id: u64,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Window controls for the in-page titlebar (macOS traffic-light style).
#[tauri::command]
fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
/// Brings the shell window to the front. Browser requests that need a decision
/// (first connection, entry picking) raise the window, otherwise the user sees
/// nothing happen in the browser while a dialog waits invisibly.
fn window_focus(window: tauri::Window) -> Result<(), String> {
    let _ = window.show();
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// Opens a link in the user's default browser. The webview's `window.open`
/// does not reach the system browser in every Tauri backend, so plugins and
/// the UI call this command instead.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let allowed = ["http://", "https://", "ftp://", "mailto:"]
        .iter()
        .any(|prefix| lower.starts_with(prefix));
    if !allowed {
        return Err("unsupported URL scheme".to_string());
    }
    open::that(url).map_err(|e| e.to_string())
}

/// Waiters for in-flight vault RPC calls.
pub struct Replies {
    waiters: std::sync::Mutex<HashMap<u64, mpsc::SyncSender<RpcReply>>>,
}

impl Default for Replies {
    fn default() -> Self {
        Self::new()
    }
}

impl Replies {
    pub fn new() -> Self {
        Self {
            waiters: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, id: u64) -> mpsc::Receiver<RpcReply> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.waiters.lock().expect("waiters lock").insert(id, tx);
        rx
    }

    pub fn take(&self, id: &u64) -> Option<mpsc::SyncSender<RpcReply>> {
        self.waiters.lock().expect("waiters lock").remove(id)
    }
}

#[cfg(all(unix, not(target_os = "android")))]
fn setup_browser_bridge(app: &tauri::App) {
    use tauri::Manager;
    let browser_state = std::sync::Arc::new(browser_bridge::BrowserState::new(
        std::sync::Arc::new(Replies::new()),
    ));
    let native_enabled = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("config/app-settings.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
        .and_then(|settings| {
            settings
                .get("nativeBrowserIntegration")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(true);
    browser_state.set_enabled(native_enabled);
    app.manage(browser_state.clone());
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        browser_bridge::serve(handle, browser_state);
    });
}

#[cfg(any(not(unix), target_os = "android"))]
fn setup_browser_bridge(_app: &tauri::App) {}

#[cfg(desktop)]
struct TrayReady;

#[cfg(desktop)]
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit KeeWeb Next", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayReady);
    Ok(())
}

/// Serves the embedded web assets over localhost HTTP.
///
/// WebKitGTK renders the app white when the same assets are served through
/// tauri's custom scheme (the page loads, scripts never run). Plain http
/// avoids the custom-scheme quirks entirely; the port is random and bound to
/// 127.0.0.1, and the server dies with the process.
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    builder
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main"
                    && window.app_handle().try_state::<TrayReady>().is_some()
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(desktop))]
            let _ = (window, event);
        })
        .on_page_load(|_webview, payload| {
            if std::env::var_os("KEEWEB_LOG_PAGE_LOAD").is_some() {
                eprintln!("[page-load] {:?} {}", payload.event(), payload.url());
            }
        })
        .invoke_handler(tauri::generate_handler![
        webdav_request,
        window_minimize,
        window_toggle_maximize,
        window_focus,
        window_close,
        open_url,
        config_store::config_load,
        config_store::config_save,
        browser_bridge::browser_rpc_reply,
        browser_bridge::set_browser_integration,
        fs_ops::file_read,
        fs_ops::file_write,
        fs_ops::file_stat,
        fs_ops::file_exists,
        fs_ops::file_delete,
        fs_ops::dir_create,
        fs_ops::pick_file,
        fs_ops::save_dialog,
        fs_ops::documents_dir,
        fs_ops::data_dir
    ])
        .setup(|app| {
            // the embedded assets are served on tauri://localhost: a secure
            // context (WebCrypto works), and app commands are allowed for it
            let builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("KeeWeb Next");
            let builder = builder.inner_size(1280.0, 800.0).min_inner_size(800.0, 600.0);
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let _window = builder.build().map_err(|e| e.to_string())?;

            #[cfg(desktop)]
            if let Err(e) = setup_tray(app) {
                eprintln!("[tray] unavailable: {}", e);
            }

            let config_dir = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("config"))
                .map_err(|e| e.to_string())?;
            let store = std::sync::Arc::new(config_store::ConfigStore::default());
            store.init(config_dir);
            app.manage(config_store::State(store.clone()));
            setup_browser_bridge(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the KeeWeb shell");
}
