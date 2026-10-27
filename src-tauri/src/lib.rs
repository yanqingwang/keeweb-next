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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
        webdav_request,
        vault_rpc_reply,
        window_minimize,
        window_toggle_maximize,
        window_close
    ])
        .setup(|app| {
            let handle = app.handle().clone();
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
