#![cfg(unix)]

//! Native-messaging bridge for browser extensions.
//!
//! The browser side is the mature KeePassXC-Browser extension: it speaks the
//! KeePassXC protocol over native messaging. A small helper binary
//! (`keeweb-next-browser-host`) is registered as the native host; it forwards
//! each framed JSON message from the browser to this process over a Unix
//! socket, and the webview answers through the same protocol implementation it
//! already uses for the in-page bridge.
//!
//! Only the user can reach the socket: it lives in `$XDG_RUNTIME_DIR` (or a
//! 0700 directory under /tmp) and is created with 0600 permissions.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

use crate::Replies;

pub const HOST_NAME: &str = "org.keepassxc.keepassxc_browser";
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);
const CHROME_EXTENSION_ID: &str = "oboonakemofpalcgghocfoadofidjkkk";
const FIREFOX_EXTENSION_ID: &str = "keepassxc-browser@keepassxc.org";

#[derive(Serialize, Clone)]
pub struct BrowserRpcCall {
    pub id: u64,
    pub connection_id: u64,
    pub request: Value,
}

/// Replies travel through the same one-shot registry the WebDAV/vault bridge
/// uses; the ids come from a separate counter so they cannot collide.
pub struct BrowserState {
    pub replies: Arc<Replies>,
    next_id: AtomicU64,
    enabled: AtomicBool,
}

impl BrowserState {
    pub fn new(replies: Arc<Replies>) -> Self {
        Self {
            replies,
            next_id: AtomicU64::new(1 << 40),
            enabled: AtomicBool::new(true),
        }
    }

    /// Installs or removes the native-messaging manifests and refuses new
    /// browser requests while disabled.
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        if enabled {
            install_manifests();
        } else {
            remove_manifests();
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
}

pub fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("KEEWEB_BROWSER_SOCKET") {
        return PathBuf::from(path);
    }
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("keeweb-next-browser.sock");
    }
    let uid = libc_getuid();
    PathBuf::from(format!("/tmp/keeweb-next-{}-browser.sock", uid))
}

fn libc_getuid() -> u32 {
    // avoid pulling the libc crate in for one call
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
        .unwrap_or(1000)
}

fn prepare_socket_dir(path: &std::path::Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        let mut perms = std::fs::metadata(dir)?.permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(dir, perms)?;
    }
    Ok(())
}

/// Binds the socket and serves one thread per browser connection.
pub fn serve(app: tauri::AppHandle, state: Arc<BrowserState>) {
    let path = socket_path();
    if let Err(e) = prepare_socket_dir(&path) {
        eprintln!("[browser-bridge] cannot prepare socket dir: {}", e);
        return;
    }
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[browser-bridge] cannot bind {:?}: {}", path, e);
            return;
        }
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let mut connection_id = 0u64;
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        connection_id += 1;
        let app = app.clone();
        let state = state.clone();
        std::thread::spawn(move || serve_connection(stream, connection_id, app, state));
    }
}

fn serve_connection(
    stream: UnixStream,
    connection_id: u64,
    app: tauri::AppHandle,
    state: Arc<BrowserState>,
) {
    let write_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let mut writer = write_stream;
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !state.enabled.load(Ordering::Relaxed) {
            let action = request
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let body = json!({
                "action": action,
                "error": "browser integration is disabled in the app settings",
                "errorCode": 0
            });
            let text = serde_json::to_string(&body).unwrap_or_default();
            let _ = writer.write_all(text.as_bytes());
            let _ = writer.write_all(b"\n");
            let _ = writer.flush();
            continue;
        }
        let action = request
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let id = state.next_id();
        let receiver: mpsc::Receiver<crate::vault_bridge::VaultRpcReply> =
            state.replies.register(id);
        let call = BrowserRpcCall {
            id,
            connection_id,
            request,
        };
        if let Err(e) = app.emit("browser-rpc", call) {
            eprintln!("[browser-bridge] cannot reach the webview: {}", e);
            break;
        }
        let response = match receiver.recv_timeout(REPLY_TIMEOUT) {
            Ok(reply) => match (reply.result, reply.error) {
                (Some(result), _) => result,
                (None, Some(error)) => {
                    json!({ "action": action, "error": error, "errorCode": 0 })
                }
                (None, None) => json!({
                    "action": action,
                    "error": "empty reply from the app",
                    "errorCode": 0
                }),
            },
            Err(_) => json!({
                "action": action,
                "error": "the app did not answer in time",
                "errorCode": 0
            }),
        };
        let body = serde_json::to_string(&response).unwrap_or_default();
        if writer.write_all(body.as_bytes()).is_err() || writer.write_all(b"\n").is_err() {
            break;
        }
        let _ = writer.flush();
    }
}

#[tauri::command]
pub fn browser_rpc_reply(
    reply: crate::vault_bridge::VaultRpcReply,
    state: tauri::State<'_, Arc<BrowserState>>,
) -> Result<(), String> {
    if let Some(sender) = state.replies.take(&reply.id) {
        sender.send(reply).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Writes the native-messaging manifests for the browsers that are installed.
///
/// The host keeps the KeePassXC-Browser host name, which is what the extension
/// looks for. If KeePassXC also provides that host, the last writer wins; the
/// settings page says so.
pub fn install_manifests() {
    let host = host_binary_path();
    let Some(host) = host else {
        return;
    };
    let host = host.to_string_lossy().to_string();

    let home = match std::env::var_os("HOME") {
        Some(home) => PathBuf::from(home),
        None => return,
    };
    let chrome_manifest = json!({
        "name": HOST_NAME,
        "description": "KeeWeb Next browser integration",
        "path": host,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{}/", CHROME_EXTENSION_ID)],
    });
    let firefox_manifest = json!({
        "name": HOST_NAME,
        "description": "KeeWeb Next browser integration",
        "path": host,
        "type": "stdio",
        "allowed_extensions": [FIREFOX_EXTENSION_ID],
    });

    let chrome_bases = [
        ".config/google-chrome",
        ".config/chromium",
        ".config/microsoft-edge",
        ".config/BraveSoftware/Brave-Browser",
        ".config/vivaldi",
    ];
    for base in chrome_bases {
        let dir = home.join(base);
        if dir.is_dir() {
            write_manifest(&dir.join("NativeMessagingHosts"), &chrome_manifest);
        }
    }
    let firefox = home.join(".mozilla");
    if firefox.is_dir() {
        write_manifest(&firefox.join("native-messaging-hosts"), &firefox_manifest);
    }
}

fn host_binary_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KEEWEB_NATIVE_HOST") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let packaged = PathBuf::from("/usr/bin/keeweb-next-browser-host");
    if packaged.is_file() {
        return Some(packaged);
    }
    // development builds keep the helper next to the app binary
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("keeweb-next-browser-host")))?;
    sibling.is_file().then_some(sibling)
}

pub fn remove_manifests() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let dirs = [
        ".config/google-chrome/NativeMessagingHosts",
        ".config/chromium/NativeMessagingHosts",
        ".config/microsoft-edge/NativeMessagingHosts",
        ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
        ".config/vivaldi/NativeMessagingHosts",
        ".mozilla/native-messaging-hosts",
    ];
    for dir in dirs {
        let path = home.join(dir).join(format!("{}.json", HOST_NAME));
        let _ = std::fs::remove_file(path);
    }
}

#[tauri::command]
pub fn set_browser_integration(
    enabled: bool,
    state: tauri::State<'_, Arc<BrowserState>>,
) {
    state.set_enabled(enabled);
}

fn write_manifest(dir: &std::path::Path, manifest: &Value) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join(format!("{}.json", HOST_NAME));
    let body = serde_json::to_vec_pretty(manifest).unwrap_or_default();
    if std::fs::write(&path, body).is_err() {
        eprintln!("[browser-bridge] cannot write {:?}", path);
    }
}
