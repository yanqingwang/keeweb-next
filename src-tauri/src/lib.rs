#[cfg(unix)]
pub mod browser_bridge;

#[cfg(unix)]
#[path = "browser_socket.rs"]
pub mod browser_socket;

#[cfg(not(unix))]
mod browser_bridge {
    use serde_json::Value;

    pub struct BrowserState;

    impl BrowserState {
        pub fn new(_replies: std::sync::Arc<crate::Replies>) -> Self {
            Self
        }
        pub fn set_enabled(&self, _enabled: bool) {}
    }

    #[tauri::command]
    pub fn browser_rpc_reply(
        _reply: crate::vault_bridge::VaultRpcReply,
    ) -> Result<(), String> {
        Err("native messaging is only supported on Linux and macOS".to_string())
    }

    #[tauri::command]
    pub fn set_browser_integration(_enabled: bool) {}

    #[allow(dead_code)]
    fn _unused(_: Option<Value>) {}
}
pub mod config_store;
mod fs_ops;
pub mod keepasshttp;
pub mod vault_bridge;
pub mod webdav;

use keepasshttp::ServerState;
use std::collections::HashMap;
use std::sync::mpsc;
use tauri::Manager;
use vault_bridge::{VaultRpcReply, WebviewVault};

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

/// Vault replies from the webview land here. The webview invokes this with
/// the call id it received; a global hook forwards the reply to the waiting
/// HTTP request.
#[tauri::command]
fn vault_rpc_reply(
    reply: VaultRpcReply,
    state: tauri::State<'_, std::sync::Arc<Replies>>,
) -> Result<(), String> {
    if let Some(sender) = state.take(&reply.id) {
        sender.send(reply).map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// Waiters for in-flight vault RPC calls.
pub struct Replies {
    waiters: std::sync::Mutex<HashMap<u64, mpsc::SyncSender<VaultRpcReply>>>,
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

    pub fn register(&self, id: u64) -> mpsc::Receiver<VaultRpcReply> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.waiters.lock().expect("waiters lock").insert(id, tx);
        rx
    }

    pub fn take(&self, id: &u64) -> Option<mpsc::SyncSender<VaultRpcReply>> {
        self.waiters.lock().expect("waiters lock").remove(id)
    }
}

#[cfg(unix)]
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

#[cfg(not(unix))]
fn setup_browser_bridge(_app: &tauri::App) {}

/// Serves the embedded web assets over localhost HTTP.
///
/// WebKitGTK renders the app white when the same assets are served through
/// tauri's custom scheme (the page loads, scripts never run). Plain http
/// avoids the custom-scheme quirks entirely; the port is random and bound to
/// 127.0.0.1, and the server dies with the process.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_page_load(|_webview, payload| {
            if std::env::var_os("KEEWEB_LOG_PAGE_LOAD").is_some() {
                eprintln!("[page-load] {:?} {}", payload.event(), payload.url());
            }
        })
        .invoke_handler(tauri::generate_handler![
        webdav_request,
        vault_rpc_reply,
        window_minimize,
        window_toggle_maximize,
        window_focus,
        window_close,
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
            .title("KeeWeb Next")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0);
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let _window = builder.build().map_err(|e| e.to_string())?;

            let handle = app.handle().clone();
            let config_dir = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("config"))
                .map_err(|e| e.to_string())?;
            let store = std::sync::Arc::new(config_store::ConfigStore::default());
            store.init(config_dir);
            app.manage(config_store::State(store.clone()));
            let replies = std::sync::Arc::new(Replies::new());
            app.manage(replies.clone());
            setup_browser_bridge(app);
            let vault = WebviewVault::new(handle.clone(), replies);
            let state = std::sync::Arc::new(ServerState {
                associations: std::sync::Mutex::new(Default::default()),
                vault: Box::new(vault),
            });

            // The KeePassHTTP endpoint binds 127.0.0.1 only and dies with the
            // process; associations are equally process-local.
            let http_handle = handle.clone();
            std::thread::spawn(move || {
                keepasshttp::serve(state, http_handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the KeeWeb shell");
}
