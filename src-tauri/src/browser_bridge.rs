
//! Native-messaging bridge for browser extensions.
//!
//! The browser side is the mature KeePassXC-Browser extension: it speaks the
//! KeePassXC protocol over native messaging. A small helper binary
//! (`keeweb-next-browser-host`) is registered as the native host; it forwards
//! each framed JSON message from the browser to this process over a loopback
//! TCP port, and the webview answers through the same protocol implementation
//! it already uses for the in-page bridge.
//!
//! Only the user can reach the port: it binds 127.0.0.1 with a random port and
//! requires a token read from a 0600 endpoint file.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

use crate::Replies;

pub const HOST_NAME: &str = "org.keepassxc.keepassxc_browser";
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);
const CHROME_EXTENSION_ID: &str = "oboonakemofpalcgghocfoadofidjkkk";
const FIREFOX_EXTENSION_ID: &str = "keepassxc-browser@keepassxc.org";

/// One frame from the browser is a JSON request; anything larger is refused
/// instead of buffered without limit.
const MAX_INCOMING_LINE: u64 = 8 * 1024 * 1024;
/// Loopback is reachable by every local user, so threads are capped.
const MAX_CONNECTIONS: usize = 16;

/// Constant-time comparison: a short-circuiting `!=` leaks the token prefix
/// through timing. The line ends with a newline, which is not part of it.
fn token_matches(received: &str, expected: &str) -> bool {
    let received = received.trim_end_matches(['\r', '\n']).as_bytes();
    let expected = expected.as_bytes();
    if received.len() != expected.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in received.iter().zip(expected) {
        diff |= a ^ b;
    }
    diff == 0
}

#[derive(Serialize, Clone)]
pub struct BrowserRpcCall {
    pub id: u64,
    pub connection_id: u64,
    pub request: Value,
}

/// Replies travel through a one-shot registry; the ids come from a separate
/// counter so they cannot collide.
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

pub fn endpoint_path() -> PathBuf {
    crate::browser_socket::endpoint_path()
}

/// Binds a loopback port and serves one thread per browser connection.
pub fn serve(app: tauri::AppHandle, state: Arc<BrowserState>) {
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[browser-bridge] cannot bind loopback port: {}", e);
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            eprintln!("[browser-bridge] cannot read listener address: {}", e);
            return;
        }
    };
    let mut token_bytes = [0u8; 32];
    if getrandom::fill(&mut token_bytes).is_err() {
        eprintln!("[browser-bridge] cannot generate an endpoint token");
        return;
    }
    let token = STANDARD.encode(token_bytes);
    let path = endpoint_path();
    if let Err(e) = crate::browser_socket::write_endpoint(&path, port, &token) {
        eprintln!("[browser-bridge] cannot write endpoint file: {}", e);
        return;
    }
    let mut connection_id = 0u64;
    let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if active.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
            continue;
        }
        active.fetch_add(1, Ordering::Relaxed);
        connection_id += 1;
        let app = app.clone();
        let state = state.clone();
        let token = token.clone();
        let active = active.clone();
        std::thread::spawn(move || {
            serve_connection(stream, token, connection_id, app, state);
            active.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

fn serve_connection(
    stream: TcpStream,
    token: String,
    connection_id: u64,
    app: tauri::AppHandle,
    state: Arc<BrowserState>,
) {
    let write_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let mut writer = write_stream;
    let mut reader = BufReader::new(stream);
    let mut auth = String::new();
    // the token line is small; a longer one is not this helper and is dropped
    // before it can grow the buffer
    match (&mut reader).take(4096).read_line(&mut auth) {
        Ok(0) | Err(_) => return,
        Ok(_) => {}
    }
    if !token_matches(&auth, &token) {
        return;
    }
    let mut line = String::new();
    loop {
        line.clear();
        let read = match (&mut reader).take(MAX_INCOMING_LINE).read_line(&mut line) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        if read as u64 >= MAX_INCOMING_LINE {
            break; // oversized frame: drop the connection
        }
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
        let receiver: mpsc::Receiver<crate::RpcReply> =
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
    reply: crate::RpcReply,
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
/// One browser's manifest directory, whether that browser is installed, and
/// which manifest flavour it needs.
pub struct ManifestTarget {
    pub dir: PathBuf,
    pub installed: bool,
    pub firefox: bool,
}

/// Where each browser looks for native-messaging manifests, paired with a
/// marker that says whether that browser is actually installed.
///
/// The layouts have nothing in common: Linux uses `~/.config/<browser>` and
/// `~/.mozilla`, while macOS puts every browser — Firefox included — under
/// `~/Library/Application Support`. Writing only the Linux paths is why the
/// Firefox extension never found the host on macOS.
#[cfg(target_os = "macos")]
pub fn manifest_targets(home: &std::path::Path) -> Vec<ManifestTarget> {
    let support = home.join("Library/Application Support");
    let apps = std::path::Path::new("/Applications");
    let user_apps = home.join("Applications");
    let bundle_installed = |bundle: &str| {
        apps.join(bundle).exists() || user_apps.join(bundle).exists()
    };

    let mut targets = Vec::new();
    let chromium = [
        ("Google/Chrome", "Google Chrome.app"),
        ("Chromium", "Chromium.app"),
        ("Microsoft Edge", "Microsoft Edge.app"),
        ("BraveSoftware/Brave-Browser", "Brave Browser.app"),
        ("Vivaldi", "Vivaldi.app"),
    ];
    for (dir, bundle) in chromium {
        let profile = support.join(dir);
        let installed = profile.is_dir() || bundle_installed(bundle);
        targets.push(ManifestTarget {
            dir: profile.join("NativeMessagingHosts"),
            installed,
            firefox: false,
        });
    }

    // Firefox reads manifests from a single shared Mozilla directory that does
    // not exist until something writes to it, so presence of Firefox itself
    // (or of its profile directory) is the only usable marker.
    let installed = bundle_installed("Firefox.app") || support.join("Firefox").is_dir();
    targets.push(ManifestTarget {
        dir: support.join("Mozilla/NativeMessagingHosts"),
        installed,
        firefox: true,
    });
    targets
}

#[cfg(not(target_os = "macos"))]
pub fn manifest_targets(home: &std::path::Path) -> Vec<ManifestTarget> {
    let mut targets = Vec::new();
    let chromium = [
        ".config/google-chrome",
        ".config/chromium",
        ".config/microsoft-edge",
        ".config/BraveSoftware/Brave-Browser",
        ".config/vivaldi",
    ];
    for dir in chromium {
        let profile = home.join(dir);
        targets.push(ManifestTarget {
            dir: profile.join("NativeMessagingHosts"),
            installed: profile.is_dir(),
            firefox: false,
        });
    }
    let firefox = home.join(".mozilla");
    targets.push(ManifestTarget {
        dir: firefox.join("native-messaging-hosts"),
        installed: firefox.is_dir(),
        firefox: true,
    });
    targets
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from)
}

pub fn install_manifests() {
    let Some(home) = home_dir() else {
        return;
    };
    install_manifests_in(&home);
}

/// Split out from [`install_manifests`] so the install/remove round trip can be
/// tested against a temporary home instead of the real one.
pub fn install_manifests_in(home: &std::path::Path) {
    let host = host_binary_path();
    let Some(host) = host else {
        eprintln!("[browser-bridge] cannot locate the native-messaging helper binary");
        return;
    };
    let host = host.to_string_lossy().to_string();

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

    #[cfg(target_os = "windows")]
    {
        install_windows_manifests(home, &chrome_manifest, &firefox_manifest);
        return;
    }

    #[cfg(not(target_os = "windows"))]
    for target in manifest_targets(home) {
        if !target.installed {
            continue;
        }
        let manifest = if target.firefox {
            &firefox_manifest
        } else {
            &chrome_manifest
        };
        write_manifest(&target.dir, manifest);
    }
}

fn host_binary_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KEEWEB_NATIVE_HOST") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    #[cfg(target_os = "windows")]
    let packaged = PathBuf::from(r"C:\Program Files\KeeWeb Next\keeweb-next-browser-host.exe");
    #[cfg(not(target_os = "windows"))]
    let packaged = PathBuf::from("/usr/bin/keeweb-next-browser-host");
    if packaged.is_file() {
        return Some(packaged);
    }
    // development builds keep the helper next to the app binary
    let helper_name = if cfg!(windows) {
        "keeweb-next-browser-host.exe"
    } else {
        "keeweb-next-browser-host"
    };
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(helper_name)))?;
    sibling.is_file().then_some(sibling)
}

pub fn remove_manifests() {
    let Some(home) = home_dir() else {
        return;
    };
    remove_manifests_in(&home);
}

pub fn remove_manifests_in(home: &std::path::Path) {
    #[cfg(target_os = "windows")]
    {
        remove_windows_manifests(home);
        return;
    }

    #[cfg(not(target_os = "windows"))]
    for target in manifest_targets(home) {
        let path = target.dir.join(format!("{}.json", HOST_NAME));
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(target_os = "windows")]
fn install_windows_manifests(
    home: &std::path::Path,
    chrome_manifest: &Value,
    firefox_manifest: &Value,
) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let dir = home
        .join("AppData")
        .join("Roaming")
        .join("KeeWeb Next")
        .join("native-hosts");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let chrome_path = dir.join("chrome.json");
    let firefox_path = dir.join("firefox.json");
    let _ = std::fs::write(
        &chrome_path,
        serde_json::to_vec_pretty(chrome_manifest).unwrap_or_default(),
    );
    let _ = std::fs::write(
        &firefox_path,
        serde_json::to_vec_pretty(firefox_manifest).unwrap_or_default(),
    );

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let register = |key: &str, manifest: &std::path::Path| {
        if let Ok((subkey, _)) = hkcu.create_subkey(key) {
            let _ = subkey.set_value("", &manifest.to_string_lossy().to_string());
        }
    };
    for browser in [
        "Google\\Chrome",
        "Chromium",
        "Microsoft\\Edge",
        "BraveSoftware\\Brave-Browser",
        "Vivaldi",
    ] {
        register(
            &format!("Software\\{}\\NativeMessagingHosts\\{}", browser, HOST_NAME),
            &chrome_path,
        );
    }
    register(
        &format!("Software\\Mozilla\\NativeMessagingHosts\\{}", HOST_NAME),
        &firefox_path,
    );
}

#[cfg(target_os = "windows")]
fn remove_windows_manifests(home: &std::path::Path) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for browser in [
        "Google\\Chrome",
        "Chromium",
        "Microsoft\\Edge",
        "BraveSoftware\\Brave-Browser",
        "Vivaldi",
    ] {
        let path = format!("Software\\{}\\NativeMessagingHosts", browser);
        let _ = hkcu.delete_subkey_all(format!("{}\\{}", path, HOST_NAME));
    }
    let _ = hkcu.delete_subkey_all(format!(
        "Software\\Mozilla\\NativeMessagingHosts\\{}",
        HOST_NAME
    ));
    let dir = home
        .join("AppData")
        .join("Roaming")
        .join("KeeWeb Next")
        .join("native-hosts");
    let _ = std::fs::remove_file(dir.join("chrome.json"));
    let _ = std::fs::remove_file(dir.join("firefox.json"));
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

#[cfg(test)]
mod tests {
    use super::token_matches;

    #[test]
    fn token_comparison_ignores_only_the_line_ending() {
        let token = "c2VjcmV0LXRva2Vu";
        assert!(token_matches(&format!("{}\n", token), token));
        assert!(token_matches(&format!("{}\r\n", token), token));
        assert!(!token_matches("", token));
        assert!(!token_matches("c2VjcmV0LXRva2VuXG4=", token));
        assert!(!token_matches("c2VjcmV0LXRva2Vu-", token));
    }
}
