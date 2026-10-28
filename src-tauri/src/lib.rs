pub mod config_store;
pub mod keepasshttp;
pub mod vault_bridge;
pub mod webdav;

use keepasshttp::ServerState;
use std::collections::HashMap;
use std::io::{Read, Write};
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

/// Serves the embedded web assets over localhost HTTP.
///
/// WebKitGTK renders the app white when the same assets are served through
/// tauri's custom scheme (the page loads, scripts never run). Plain http
/// avoids the custom-scheme quirks entirely; the port is random and bound to
/// 127.0.0.1, and the server dies with the process.
fn serve_ui(app: tauri::AppHandle) -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("failed to bind a port for the UI server");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = 'read: loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break 'read 0usize,
                    Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                    Err(_) => break 'read 0usize,
                }
                if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                    break 'read pos + 4;
                }
                if buffer.len() > 32 * 1024 {
                    break 'read 0usize;
                }
            };
            let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
            let path = head
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .split('?')
                .next()
                .unwrap_or("/")
                .to_string();
            let asset_path = if path == "/" {
                "index.html".to_string()
            } else {
                path.trim_start_matches('/').to_string()
            };
            let (bytes, mime) = match app.asset_resolver().get(asset_path.clone()) {
                Some(asset) => {
                    let mime = match asset_path.rsplit('.').next() {
                        Some("html") => "text/html; charset=utf-8",
                        Some("js") => "application/javascript",
                        Some("css") => "text/css",
                        Some("png") => "image/png",
                        Some("svg") => "image/svg+xml",
                        Some("json") => "application/json",
                        Some("woff2") => "font/woff2",
                        _ => "application/octet-stream",
                    };
                    (asset.bytes, mime.to_string())
                }
                None => {
                    match app.asset_resolver().get("index.html".to_string()) {
                        Some(fallback) => (fallback.bytes, "text/html; charset=utf-8".to_string()),
                        None => (b"not found".to_vec(), "text/plain".to_string()),
                    }
                }
            };
            let http = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                mime,
                bytes.len()
            );
            let _ = stream.write_all(http.as_bytes());
            let _ = stream.write_all(&bytes);
            let _ = stream.flush();
        }
    });
    port
}

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
        window_close,
        config_store::config_load,
        config_store::config_save
    ])
        .setup(|app| {
            // WebKitGTK renders a blank window when the app is loaded through
            // tauri's custom scheme (the document loads, no script runs), so
            // the shell serves its embedded assets over loopback http instead.
            let ui_port = serve_ui(app.handle().clone());
            let url = format!("http://127.0.0.1:{}/", ui_port);
            let builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().expect("ui url")),
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
            let vault = WebviewVault::new(handle.clone(), replies);
            let state = std::sync::Arc::new(ServerState {
                associations: std::sync::Mutex::new(Default::default()),
                vault: Box::new(vault),
            });

            // The KeePassHTTP endpoint binds 127.0.0.1 only and dies with the
            // process; associations are equally process-local.
            std::thread::spawn(move || {
                keepasshttp::serve(state, handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the KeeWeb shell");
}
