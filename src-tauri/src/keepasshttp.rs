//! KeePassHTTP-compatible endpoint for browser extensions and KeePass
//! plugins, served on 127.0.0.1 only.
//!
//! The protocol (github.com/pfn/keepasshttp): every request is JSON over POST;
//! the client and server share a 256-bit AES-256-CBC key established during
//! `associate`. `Verifier` is the base64 nonce encrypted with that key —
//! replaying it under a different nonce fails. Responses carry a fresh nonce
//! and encrypt every payload field with the same key. The database identity
//! (`Hash`) is a SHA-1 over root+recycle-bin UUIDs, so extensions can detect
//! a database change.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use aes::Aes256;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use cbc::cipher::{
    block_padding::Pkcs7, BlockModeDecrypt, BlockModeEncrypt, KeyIvInit,
};
use serde::{Deserialize, Serialize};
use hmac::{Hmac, Mac};
use sha1::{Digest, Sha1};
use sha2::Sha256;

pub const PORT: u16 = 19455;
/// Where associated keys are stored inside the vault ("KeePassHttp Settings"
/// entry), matching the upstream plugin. Used by the webview side when it
/// persists an approved association.
#[allow(dead_code)] // the webview side uses it when persisting approvals
pub const ASSOCIATE_KEY_PREFIX: &str = "AES Key: ";
/// Protocol level of the upstream KeePassHTTP this endpoint follows. Clients
/// only display it, but keeping it in step documents what we implement.
pub const PROTOCOL_VERSION: &str = "2.3.1.0";

/// Enforced by the HTTP layer once the listener is wired into the shell.
pub const MAX_REQUEST_BODY: usize = 1 << 20;

type Aes256CbcEnc = cbc::Encryptor<Aes256>;
type Aes256CbcDec = cbc::Decryptor<Aes256>;

pub fn encrypt(plain: &[u8], key: &[u8], iv: &[u8]) -> Vec<u8> {
    Aes256CbcEnc::new_from_slices(key, iv)
        .expect("key/iv lengths are enforced by the callers")
        .encrypt_padded_vec::<Pkcs7>(plain)
}

pub fn decrypt(cipher_text: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, &'static str> {
    if cipher_text.is_empty() || !cipher_text.len().is_multiple_of(16) {
        return Err("bad ciphertext length");
    }
    Aes256CbcDec::new_from_slices(key, iv)
        .map_err(|_| "bad key or iv length")?
        .decrypt_padded_vec::<Pkcs7>(cipher_text)
        .map_err(|_| "padding check failed")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
#[allow(dead_code)] // the wire format carries more than the handlers read
pub struct Request {
    pub request_type: String,
    // part of the wire format; plugins always send them, the handlers do
    // not branch on them
    #[serde(default)]
    pub trigger_unlock: bool,
    #[serde(default)]
    pub sort_selection: Option<serde_json::Value>,
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub uuid: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub submit_url: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub verifier: Option<String>,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub hmac: Option<String>,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub realm: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct Response {
    pub request_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub count: u32,
    pub version: &'static str,
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<ResponseEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hmac: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct ResponseEntry {
    pub login: String,
    pub password: Option<String>,
    pub uuid: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub string_fields: Option<Vec<StringField>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct StringField {
    pub key: String,
    pub value: String,
}

/// One associated client: an id chosen in the UI plus the shared AES key.
#[derive(Debug, Clone)]
pub struct Association {
    pub id: String,
    pub key: Vec<u8>,
}

#[derive(Debug)]
pub struct VaultQuery {
    pub url: String,
    #[allow(dead_code)] // handed to the webview for host-based permissions
    pub submit_url: Option<String>,
    #[allow(dead_code)]
    pub realm: Option<String>,
}

pub struct VaultAnswer {
    pub entries: Vec<VaultEntry>,
    /// false: the user denied this request in the webview dialog
    pub allowed: bool,
    /// false: the vault is locked, the API cannot answer
    pub unlocked: bool,
}

#[derive(Debug, Clone)]
pub struct VaultEntry {
    pub uuid: String,
    pub name: String,
    pub login: String,
    pub password: String,
}

/// What the shell asks the webview to do before answering a request.
#[derive(Debug)]
pub enum VaultRequest {
    /// The user must confirm (or reject) a new association key.
    ConfirmAssociation { key: Vec<u8> },
    /// Look up matching entries for an (already decrypted) url.
    GetLogins(VaultQuery),
    /// Every entry of the unlocked database.
    GetAllLogins,
    /// Entries whose title matches one of the names.
    GetLoginsByNames { names: Vec<String> },
    /// Write a login into the vault (confirmed by the user in the webview).
    SetLogin {
        uuid: Option<String>,
        login: String,
        password: String,
        url: String,
        #[allow(dead_code)] // the webview records which association wrote
        association_id: String,
    },
}

pub type VaultReply = Result<VaultAnswer, String>;

/// The vault side of the bridge, implemented by the webview layer.
pub trait Vault: Send + Sync {
    fn request(&self, request: VaultRequest) -> VaultReply;
    fn database_hash(&self) -> Result<String, &'static str>;
}

/// Associations are persisted next to the app config, so a paired browser
/// extension survives a restart. The file is user-private (0600 on Unix) and
/// contains only the client id and the shared AES key.
pub struct ServerState {
    pub associations: Mutex<HashMap<String, Association>>,
    /// Verifiers already accepted, with the time they were seen. The verifier
    /// is a function of (key, nonce), so a captured request stays valid
    /// forever otherwise: replaying it would hand out the whole vault.
    seen_verifiers: Mutex<HashMap<String, std::time::Instant>>,
    pub vault: Box<dyn Vault>,
    store_path: Option<std::path::PathBuf>,
}

/// A client picks a fresh random nonce per request, so a repeated verifier
/// inside this window is a replay.
const REPLAY_WINDOW: std::time::Duration = std::time::Duration::from_secs(600);
const MAX_SEEN_VERIFIERS: usize = 4096;

impl ServerState {
    pub fn load(vault: Box<dyn Vault>, store_path: Option<std::path::PathBuf>) -> Self {
        let mut associations = HashMap::new();
        if let Some(path) = &store_path {
            if let Ok(body) = std::fs::read(path) {
                if let Ok(stored) = serde_json::from_slice::<HashMap<String, String>>(&body) {
                    for (id, key) in stored {
                        if let Ok(key) = STANDARD.decode(key) {
                            if key.len() == 32 {
                                associations.insert(id.clone(), Association { id, key });
                            }
                        }
                    }
                }
            }
        }
        Self {
            associations: Mutex::new(associations),
            seen_verifiers: Mutex::new(HashMap::new()),
            vault,
            store_path,
        }
    }

    /// Records a verifier and answers whether it is fresh. Replaying an
    /// already accepted (id, verifier) pair within REPLAY_WINDOW is refused.
    fn claim_verifier(&self, association_id: &str, verifier: &str) -> bool {
        let mut seen = self.seen_verifiers.lock().expect("verifiers lock");
        let now = std::time::Instant::now();
        seen.retain(|_, at| now.duration_since(*at) < REPLAY_WINDOW);
        let key = format!("{}:{}", association_id, verifier);
        if seen.contains_key(&key) {
            return false;
        }
        if seen.len() >= MAX_SEEN_VERIFIERS {
            if let Some(oldest) = seen
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(key, _)| key.clone())
            {
                seen.remove(&oldest);
            }
        }
        seen.insert(key, now);
        true
    }

    fn persist(&self) {
        let Some(path) = &self.store_path else {
            return;
        };
        let stored: HashMap<String, String> = self
            .associations
            .lock()
            .expect("associations lock")
            .iter()
            .map(|(id, association)| (id.clone(), STANDARD.encode(&association.key)))
            .collect();
        let Ok(body) = serde_json::to_vec(&stored) else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, body).is_err() {
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::rename(&tmp, path);
    }
}

fn sha1_hex(input: &str) -> String {
    let digest = {
        let mut hasher = Sha1::new();
        hasher.update(input.as_bytes());
        hasher.finalize()
    };
    hex_encode(&digest).unwrap_or_default()
}

fn hex_encode(bytes: &[u8]) -> Option<String> {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{:02x}", byte));
    }
    Some(out)
}

pub fn verify(verifier: &str, nonce: &str, key: &[u8]) -> Result<bool, &'static str> {
    let verifier_bytes = STANDARD.decode(verifier).map_err(|_| "bad verifier")?;
    let nonce_bytes = STANDARD.decode(nonce).map_err(|_| "bad nonce")?;
    if nonce_bytes.len() != 16 {
        return Err("bad nonce length");
    }
    if key.len() != 32 {
        return Err("bad key length");
    }
    let plain = decrypt(&verifier_bytes, key, &nonce_bytes)?;
    Ok(plain == nonce.as_bytes())
}

fn verify_request_hmac(request: &Request, association: &Association) -> bool {
    let (Some(hmac_b64), Some(verifier_b64), Some(nonce_b64)) =
        (&request.hmac, &request.verifier, &request.nonce)
    else {
        return true; // older clients do not send it
    };
    let (Ok(received), Ok(cipher), Ok(iv)) = (
        STANDARD.decode(hmac_b64),
        STANDARD.decode(verifier_b64),
        STANDARD.decode(nonce_b64),
    ) else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(&association.key).expect("hmac key");
    mac.update(&iv);
    mac.update(&cipher);
    mac.verify_slice(&received).is_ok()
}

fn key_for(state: &ServerState, request: &Request) -> Result<Association, Box<Response>> {
    let (Some(id), Some(verifier), Some(nonce)) =
        (&request.id, &request.verifier, &request.nonce)
    else {
        return Err(Box::new(error_response("", "", None)));
    };
    let association = {
        let associations = state.associations.lock().expect("associations lock");
        match associations.get(id) {
            Some(association) => association.clone(),
            None => return Err(Box::new(error_response("", "", None))),
        }
    };
    if verify(verifier, nonce, &association.key) != Ok(true)
        || !verify_request_hmac(request, &association)
    {
        return Err(Box::new(error_response("", "", None)));
    }
    if !state.claim_verifier(&association.id, verifier) {
        return Err(Box::new(error_response("", "", None)));
    }
    Ok(association)
}

fn error_response(request_type: &str, hash: &str, id: Option<String>) -> Response {
    Response {
        request_type: request_type.to_string(),
        error: None,
        success: false,
        id,
        count: 0,
        version: PROTOCOL_VERSION,
        hash: hash.to_string(),
        entries: None,
        nonce: None,
        verifier: None,
        hmac: None,
    }
}

fn plain_response(
    request_type: &str,
    hash: &str,
    association: &Association,
) -> (Response, [u8; 16]) {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).expect("OS entropy unavailable");
    let nonce_b64 = STANDARD.encode(nonce);
    let mut response = Response {
        request_type: request_type.to_string(),
        error: None,
        success: true,
        id: Some(association.id.clone()),
        count: 0,
        version: PROTOCOL_VERSION,
        hash: hash.to_string(),
        entries: None,
        // clients verify Verifier by decrypting it with IV = Nonce and
        // comparing the plaintext to the Nonce string, so the plaintext is
        // the base64 text, not the raw bytes
        verifier: Some(STANDARD.encode(encrypt(
            nonce_b64.as_bytes(),
            &association.key,
            &nonce,
        ))),
        nonce: Some(nonce_b64),
        hmac: None,
    };
    let cipher = STANDARD.decode(response.verifier.as_deref().unwrap_or_default()).unwrap_or_default();
    let mut mac = Hmac::<Sha256>::new_from_slice(&association.key).expect("hmac key");
    mac.update(&nonce);
    mac.update(&cipher);
    response.hmac = Some(STANDARD.encode(mac.finalize().into_bytes()));
    (response, nonce)
}

/// Binds 127.0.0.1:PORT and serves requests until the process dies.
pub fn serve(state: std::sync::Arc<ServerState>, app: tauri::AppHandle) {
    let listener = match std::net::TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!(
                "[keepasshttp] port {} is busy ({}); browser integration is off",
                PORT, e
            );
            return;
        }
    };
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        // the API exists for browser extensions on this machine; anything
        // arriving from another interface is dropped before a handshake
        if !stream
            .peer_addr()
            .map(|addr| addr.ip().is_loopback())
            .unwrap_or(false)
        {
            continue;
        }
        if ACTIVE_CONNECTIONS.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
            let _ = reject(&stream, "429 Too Many Requests");
            continue;
        }
        ACTIVE_CONNECTIONS.fetch_add(1, Ordering::Relaxed);
        let state = state.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = serve_one(stream, state, app);
            ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

/// A loopback port accepts connections from every local user, so unbounded
/// threads would let any process starve the endpoint by opening sockets.
const MAX_CONNECTIONS: usize = 16;

static ACTIVE_CONNECTIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Header lookup is case-insensitive and only looks at the request head.
fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

/// Web pages always name their origin; native KeePassHTTP clients do not send
/// one at all, and extension backgrounds use a non-web scheme. Anything that
/// looks like a page is refused, which is what keeps a hostile site from
/// driving this endpoint through CORS.
fn origin_is_web_page(origin: &str) -> bool {
    let lower = origin.to_ascii_lowercase();
    lower == "null" || lower.starts_with("http://") || lower.starts_with("https://")
}

/// Host is the one header a DNS-rebinding page cannot change: the TCP peer is
/// loopback either way, but the Host it sends is the attacker's name.
fn host_is_loopback(host: &str) -> bool {
    let name = if host.starts_with('[') {
        match host.find(']') {
            Some(end) => &host[..=end],
            None => return false,
        }
    } else {
        host.split(':').next().unwrap_or(host)
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "[::1]"
    )
}

fn reject(mut stream: &std::net::TcpStream, status: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\
         Connection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn serve_one(
    mut stream: std::net::TcpStream,
    state: std::sync::Arc<ServerState>,
    app: tauri::AppHandle,
) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(30)));
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_REQUEST_BODY {
            return Ok(());
        }
        if let Some(pos) = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        {
            break pos + 4;
        }
        if buffer.len() > 64 * 1024 {
            return Ok(()); // header absurdly large; drop the connection
        }
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let content_length = head
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|line| line.split(':').nth(1))
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_REQUEST_BODY {
        return Ok(());
    }
    while buffer.len() < header_end + content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }

    let method = head
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    // KeePassHTTP clients are native or extension backgrounds and always POST
    // JSON; a page cannot send that without a preflight, and there is no
    // preflight answer any more.
    if method != "POST" {
        return reject(&stream, "405 Method Not Allowed");
    }
    if let Some(host) = header(&head, "host") {
        if !host_is_loopback(host) {
            return reject(&stream, "421 Misdirected Request");
        }
    }
    if let Some(origin) = header(&head, "origin") {
        if origin_is_web_page(origin) {
            return reject(&stream, "403 Forbidden");
        }
    }
    if let Some(content_type) = header(&head, "content-type") {
        if !content_type.to_ascii_lowercase().contains("application/json") {
            return reject(&stream, "415 Unsupported Media Type");
        }
    }

    let body_start = header_end;
    let body_end = (header_end + content_length).min(buffer.len());
    let request: Request = match serde_json::from_slice(&buffer[body_start..body_end]) {
        Ok(request) => request,
        Err(_) => return Ok(()),
    };

    let response = handle_request(&state, request);
    let body = serde_json::to_vec(&response).unwrap_or_default();
    let http = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(http.as_bytes())?;
    stream.write_all(&body)?;
    stream.flush()?;
    drop(app);
    Ok(())
}

fn entries_response(
    request_type: &str,
    hash: &str,
    association: &Association,
    entries: &[VaultEntry],
) -> Response {
    let (mut response, response_nonce) = plain_response(request_type, hash, association);
    response.count = entries.len() as u32;
    response.entries = Some(
        entries
            .iter()
            .map(|entry| ResponseEntry {
                login: STANDARD.encode(encrypt(
                    entry.login.as_bytes(),
                    &association.key,
                    &response_nonce,
                )),
                password: Some(STANDARD.encode(encrypt(
                    entry.password.as_bytes(),
                    &association.key,
                    &response_nonce,
                ))),
                uuid: STANDARD.encode(encrypt(
                    entry.uuid.as_bytes(),
                    &association.key,
                    &response_nonce,
                )),
                name: STANDARD.encode(encrypt(
                    entry.name.as_bytes(),
                    &association.key,
                    &response_nonce,
                )),
                string_fields: None,
            })
            .collect(),
    );
    response
}

fn locked_error(request_type: &str, hash: &str, id: &str) -> Response {
    let mut response = error_response(request_type, hash, Some(id.to_string()));
    response.error = Some("database is locked".to_string());
    response
}

fn rejected_error(request_type: &str, hash: &str, id: &str) -> Response {
    let mut response = error_response(request_type, hash, Some(id.to_string()));
    response.error = Some("user rejected the request".to_string());
    response
}

pub fn handle_request(state: &ServerState, request: Request) -> Response {
    let hash = state.vault.database_hash().unwrap_or_default();

    match request.request_type.as_str() {
        "test-associate" => {
            let association = match key_for(state, &request) {
                Ok(a) => a,
                Err(response) => return *response,
            };
            let (mut response, _) = plain_response("test-associate", &hash, &association);
            response.count = 0;
            response
        }
        "associate" => {
            let (Some(key_b64), Some(verifier), Some(nonce)) =
                (&request.key, &request.verifier, &request.nonce)
            else {
                return error_response("associate", &hash, None);
            };
            let (Ok(key_bytes), Ok(nonce_bytes)) =
                (STANDARD.decode(key_b64), STANDARD.decode(nonce))
            else {
                return error_response("associate", &hash, None);
            };
            if key_bytes.len() != 32 || nonce_bytes.len() != 16 {
                return error_response("associate", &hash, None);
            }
            let verifier_bytes = match STANDARD.decode(verifier) {
                Ok(bytes) => bytes,
                Err(_) => return error_response("associate", &hash, None),
            };
            let verified = decrypt(&verifier_bytes, &key_bytes, &nonce_bytes)
                .map(|plain| plain == nonce.as_bytes())
                .unwrap_or(false);
            if !verified {
                return error_response("associate", &hash, None);
            }
            let answer = state
                .vault
                .request(VaultRequest::ConfirmAssociation {
                    key: key_bytes.clone(),
                })
                .unwrap_or_else(|_| VaultAnswer {
                    entries: vec![],
                    allowed: false,
                    unlocked: true,
                });
            if !answer.allowed {
                return error_response("associate", &hash, None);
            }
            // The id is the SHA-1 of the key, the same scheme KeePassHTTP
            // uses: deterministic, unique per key, no server-side state.
            let id = sha1_hex(key_b64);
            let association = Association {
                id: id.clone(),
                key: key_bytes,
            };
            state
                .associations
                .lock()
                .expect("associations lock")
                .insert(id, association.clone());
            state.persist();
            let (response, _) = plain_response("associate", &hash, &association);
            response
        }
        "get-logins" | "get-logins-count" => {
            let association = match key_for(state, &request) {
                Ok(a) => a,
                Err(response) => return *response,
            };

            let (Some(url_b64), Some(nonce)) = (&request.url, &request.nonce) else {
                return error_response(&request.request_type, &hash, Some(association.id.clone()));
            };
            let (Ok(url_bytes), Ok(nonce_bytes)) =
                (STANDARD.decode(url_b64), STANDARD.decode(nonce))
            else {
                return error_response(&request.request_type, &hash, Some(association.id.clone()));
            };
            let url = match decrypt(&url_bytes, &association.key, &nonce_bytes) {
                Ok(plain) => match String::from_utf8(plain) {
                    Ok(url) => url,
                    Err(_) => {
                        return error_response(
                            &request.request_type,
                            &hash,
                            Some(association.id.clone()),
                        )
                    }
                },
                Err(_) => {
                    return error_response(&request.request_type, &hash, Some(association.id.clone()))
                }
            };
            let submit_url = match &request.submit_url {
                Some(submit_b64) => {
                    let (Ok(bytes), Ok(iv)) =
                        (STANDARD.decode(submit_b64), STANDARD.decode(nonce))
                    else {
                        return error_response(
                            &request.request_type,
                            &hash,
                            Some(association.id.clone()),
                        );
                    };
                    match decrypt(&bytes, &association.key, &iv) {
                        Ok(plain) => String::from_utf8(plain).ok(),
                        Err(_) => {
                            return error_response(
                                &request.request_type,
                                &hash,
                                Some(association.id.clone()),
                            )
                        }
                    }
                }
                None => None,
            };

            let realm = match &request.realm {
                Some(realm_b64) => {
                    let (Ok(bytes), Ok(iv)) =
                        (STANDARD.decode(realm_b64), STANDARD.decode(nonce))
                    else {
                        return error_response(
                            &request.request_type,
                            &hash,
                            Some(association.id.clone()),
                        );
                    };
                    match decrypt(&bytes, &association.key, &iv) {
                        Ok(plain) => String::from_utf8(plain).ok(),
                        Err(_) => {
                            return error_response(
                                &request.request_type,
                                &hash,
                                Some(association.id.clone()),
                            )
                        }
                    }
                }
                None => None,
            };

            let answer = state
                .vault
                .request(VaultRequest::GetLogins(VaultQuery {
                    url,
                    submit_url,
                    realm,
                }))
                .unwrap_or_else(|_| VaultAnswer {
                    entries: vec![],
                    allowed: false,
                    unlocked: false,
                });
            if !answer.unlocked {
                return locked_error(&request.request_type, &hash, &association.id);
            }
            if !answer.allowed {
                return rejected_error(&request.request_type, &hash, &association.id);
            }
            if request.request_type == "get-logins-count" {
                let (mut response, _) = plain_response(&request.request_type, &hash, &association);
                response.count = answer.entries.len() as u32;
                return response;
            }
            entries_response(&request.request_type, &hash, &association, &answer.entries)
        }
        "get-all-logins" => {
            let association = match key_for(state, &request) {
                Ok(a) => a,
                Err(response) => return *response,
            };
            let answer = state
                .vault
                .request(VaultRequest::GetAllLogins)
                .unwrap_or_else(|_| VaultAnswer {
                    entries: vec![],
                    allowed: false,
                    unlocked: false,
                });
            if !answer.unlocked {
                return locked_error("get-all-logins", &hash, &association.id);
            }
            if !answer.allowed {
                return rejected_error("get-all-logins", &hash, &association.id);
            }
            entries_response("get-all-logins", &hash, &association, &answer.entries)
        }
        "get-logins-by-names" => {
            let association = match key_for(state, &request) {
                Ok(a) => a,
                Err(response) => return *response,
            };
            let Some(nonce) = request.nonce.as_deref() else {
                return error_response("get-logins-by-names", &hash, Some(association.id.clone()));
            };
            let Ok(iv) = STANDARD.decode(nonce) else {
                return error_response("get-logins-by-names", &hash, Some(association.id.clone()));
            };
            let mut names = Vec::with_capacity(request.names.len());
            for name_b64 in &request.names {
                let Ok(bytes) = STANDARD.decode(name_b64) else {
                    return error_response(
                        "get-logins-by-names",
                        &hash,
                        Some(association.id.clone()),
                    );
                };
                match decrypt(&bytes, &association.key, &iv)
                    .ok()
                    .and_then(|plain| String::from_utf8(plain).ok())
                {
                    Some(name) => names.push(name),
                    None => {
                        return error_response(
                            "get-logins-by-names",
                            &hash,
                            Some(association.id.clone()),
                        )
                    }
                }
            }
            let answer = state
                .vault
                .request(VaultRequest::GetLoginsByNames { names })
                .unwrap_or_else(|_| VaultAnswer {
                    entries: vec![],
                    allowed: false,
                    unlocked: false,
                });
            if !answer.unlocked {
                return locked_error("get-logins-by-names", &hash, &association.id);
            }
            if !answer.allowed {
                return rejected_error("get-logins-by-names", &hash, &association.id);
            }
            entries_response("get-logins-by-names", &hash, &association, &answer.entries)
        }
        "set-login" => {
            let association = match key_for(state, &request) {
                Ok(a) => a,
                Err(response) => return *response,
            };

            let (Some(nonce), Some(url_b64), Some(login_b64), Some(password_b64)) =
                (&request.nonce, &request.url, &request.login, &request.password)
            else {
                return error_response("set-login", &hash, Some(association.id.clone()));
            };
            let (Ok(nonce_bytes), Ok(url_bytes), Ok(login_bytes), Ok(password_bytes)) = (
                STANDARD.decode(nonce),
                STANDARD.decode(url_b64),
                STANDARD.decode(login_b64),
                STANDARD.decode(password_b64),
            ) else {
                return error_response("set-login", &hash, Some(association.id.clone()));
            };
            let (Ok(url_plain), Ok(login_plain), Ok(password_plain)) = (
                decrypt(&url_bytes, &association.key, &nonce_bytes),
                decrypt(&login_bytes, &association.key, &nonce_bytes),
                decrypt(&password_bytes, &association.key, &nonce_bytes),
            ) else {
                return error_response("set-login", &hash, Some(association.id.clone()));
            };
            let (Ok(url), Ok(login), Ok(password)) = (
                String::from_utf8(url_plain),
                String::from_utf8(login_plain),
                String::from_utf8(password_plain),
            ) else {
                return error_response("set-login", &hash, Some(association.id.clone()));
            };
            let uuid = match &request.uuid {
                Some(uuid_b64) => {
                    let Ok(bytes) = STANDARD.decode(uuid_b64) else {
                        return error_response("set-login", &hash, Some(association.id.clone()));
                    };
                    match decrypt(&bytes, &association.key, &nonce_bytes) {
                        Ok(plain) => hex_encode(&plain),
                        Err(_) => {
                            return error_response("set-login", &hash, Some(association.id.clone()))
                        }
                    }
                }
                None => None,
            };

            let answer = state
                .vault
                .request(VaultRequest::SetLogin {
                    uuid,
                    login,
                    password,
                    url: url.clone(),
                    association_id: association.id.clone(),
                })
                .unwrap_or_else(|_| VaultAnswer {
                    entries: vec![],
                    allowed: false,
                    unlocked: false,
                });
            if !answer.unlocked {
                let mut response = error_response("set-login", &hash, Some(association.id.clone()));
                response.error = Some("database is locked".to_string());
                return response;
            }
            if !answer.allowed {
                let mut response = error_response("set-login", &hash, Some(association.id.clone()));
                response.error = Some("user rejected the request".to_string());
                return response;
            }
            let (response, _) = plain_response("set-login", &hash, &association);
            response
        }
        other => {
            let mut response = error_response(other, &hash, None);
            response.error = Some(format!("unknown command: {}", other));
            response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestVault;

    impl Vault for TestVault {
        fn request(&self, _request: VaultRequest) -> VaultReply {
            Ok(VaultAnswer {
                entries: vec![],
                allowed: true,
                unlocked: true,
            })
        }

        fn database_hash(&self) -> Result<String, &'static str> {
            Ok(String::new())
        }
    }

    #[test]
    fn host_header_must_be_loopback() {
        assert!(host_is_loopback("127.0.0.1:19455"));
        assert!(host_is_loopback("localhost:19455"));
        assert!(host_is_loopback("[::1]:19455"));
        assert!(!host_is_loopback("evil.example:19455"));
        assert!(!host_is_loopback("127.0.0.1.evil.example"));
        assert!(!host_is_loopback(""));
    }

    #[test]
    fn web_page_origins_are_refused() {
        assert!(origin_is_web_page("https://evil.example"));
        assert!(origin_is_web_page("http://localhost:3000"));
        assert!(origin_is_web_page("null"));
        assert!(!origin_is_web_page("chrome-extension://abcdef"));
        assert!(!origin_is_web_page("moz-extension://abcdef"));
    }

    #[test]
    fn a_verifier_cannot_be_replayed() {
        let state = ServerState::load(Box::new(TestVault), None);
        assert!(state.claim_verifier("id", "verifier"));
        assert!(!state.claim_verifier("id", "verifier"));
        // another association's identical verifier is a different request
        assert!(state.claim_verifier("other", "verifier"));
    }
}
