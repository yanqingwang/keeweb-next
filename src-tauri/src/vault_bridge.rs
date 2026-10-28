//! Glue between the KeePassHTTP endpoint and the webview vault.
//!
//! The vault lives in the web UI, so every `VaultRequest` is shipped to the
//! main window as a `vault-rpc` event with a call id; the webview answers
//! through the `vault_rpc_reply` command and the one-shot channel resolves.
//! A request that is not answered within the timeout fails in the open
//! instead of hanging the extension's HTTP call.

use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Wry};

use crate::keepasshttp::{
    Vault, VaultAnswer, VaultEntry, VaultQuery, VaultReply, VaultRequest,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize, Clone)]
pub struct VaultRpcCall {
    pub id: u64,
    pub cmd: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct VaultRpcReply {
    pub id: u64,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Sends `vault-rpc` events to the main window and collects replies sent back
/// through the `vault_rpc_reply` command.
pub struct WebviewVault {
    manager: tauri::AppHandle<Wry>,
    replies: std::sync::Arc<crate::Replies>,
    next_id: std::sync::atomic::AtomicU64,
}

impl WebviewVault {
    pub fn new(manager: tauri::AppHandle, replies: std::sync::Arc<crate::Replies>) -> Self {
        Self {
            manager,
            replies,
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn call(&self, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let payload = VaultRpcCall {
            id,
            cmd: cmd.to_string(),
            args,
        };

        let rx = self.replies.register(id);

        self.manager
            .emit("vault-rpc", payload)
            .map_err(|e| format!("failed to reach the webview: {}", e))?;

        let outcome = rx.recv_timeout(RPC_TIMEOUT);
        match outcome {
            Ok(reply) => {
                if let Some(error) = reply.error {
                    return Err(error);
                }
                reply.result.ok_or_else(|| "empty reply".to_string())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Err(
                "the webview did not answer in time (is the vault unlocked?)".to_string(),
            ),
            Err(_) => Err("the webview dropped the connection".to_string()),
        }
    }
}

impl Vault for WebviewVault {
    fn request(&self, request: VaultRequest) -> VaultReply {
        let (cmd, args) = match request {
            VaultRequest::ConfirmAssociation { .. } => {
                // the webview shows the confirmation dialog
                ("vault.confirm-association".to_string(), serde_json::json!({}))
            }
            VaultRequest::GetLogins(VaultQuery {
                url,
                submit_url,
                realm,
            }) => (
                "vault.find-logins".to_string(),
                serde_json::json!({ "url": url, "submitUrl": submit_url, "realm": realm }),
            ),
            VaultRequest::GetAllLogins => ("vault.all-logins".to_string(), serde_json::json!({})),
            VaultRequest::GetLoginsByNames { names } => (
                "vault.find-by-names".to_string(),
                serde_json::json!({ "names": names }),
            ),
            VaultRequest::SetLogin { login, password, url, .. } => (
                "vault.set-login".to_string(),
                serde_json::json!({ "login": login, "password": password, "url": url }),
            ),
        };

        let value = self.call(&cmd, args)?;
        let allowed = value
            .get("allowed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let unlocked = value
            .get("unlocked")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        let entries = value
            .get("entries")
            .and_then(serde_json::Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|entry| VaultEntry {
                        uuid: entry
                            .get("uuid")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        name: entry
                            .get("title")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        login: entry
                            .get("login")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        password: entry
                            .get("password")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(VaultAnswer {
            entries,
            allowed,
            unlocked,
        })
    }

    fn database_hash(&self) -> Result<String, &'static str> {
        self.call("vault.hash", serde_json::json!({}))
            .ok()
            .and_then(|value| {
                value
                    .get("hash")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .ok_or("vault unavailable")
    }
}
