//! Native file helpers for the webview shell.
//!
//! The webview has no Node process, so the handful of Launcher file calls the
//! app makes (saving a copy, backups, choosing a key file) go through these
//! commands. They are local app commands: only the shell's own page can call
//! them, and they are user-initiated file picks or paths the app already owns.
//!
//! File contents cross the IPC boundary base64-encoded: a database is binary
//! and the JSON channel would otherwise carry one number per byte.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

/// Error shape the JavaScript side expects: storage code checks `err.code`
/// for `ENOENT` / `EISDIR`, the same values the Node launcher produced.
#[derive(Serialize)]
pub struct FsError {
    code: &'static str,
    message: String,
}

impl From<std::io::Error> for FsError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let code = match err.kind() {
            ErrorKind::NotFound => "ENOENT",
            ErrorKind::IsADirectory => "EISDIR",
            ErrorKind::PermissionDenied => "EACCES",
            ErrorKind::AlreadyExists => "EEXIST",
            _ => "EIO",
        };
        Self {
            code,
            message: err.to_string(),
        }
    }
}

#[derive(Serialize)]
pub struct FileStat {
    size: u64,
    /// Milliseconds, matching what the JavaScript side turns into a Date.
    mtime_ms: f64,
    is_dir: bool,
    #[cfg(unix)]
    uid: u32,
}

#[tauri::command]
pub fn file_read(path: String) -> Result<String, FsError> {
    let bytes = std::fs::read(path)?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub fn file_write(path: String, data: String) -> Result<(), FsError> {
    let bytes = STANDARD.decode(data).map_err(|e| FsError {
        code: "EIO",
        message: e.to_string(),
    })?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[tauri::command]
pub fn file_stat(path: String) -> Result<FileStat, FsError> {
    let meta = std::fs::metadata(path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    #[cfg(unix)]
    let uid = std::os::unix::fs::MetadataExt::uid(&meta);
    Ok(FileStat {
        size: meta.len(),
        mtime_ms: mtime,
        is_dir: meta.is_dir(),
        #[cfg(unix)]
        uid,
    })
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub fn file_delete(path: String) -> Result<(), FsError> {
    let path = std::path::Path::new(&path);
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[tauri::command]
pub fn dir_create(path: String) -> Result<(), FsError> {
    std::fs::create_dir_all(path)?;
    Ok(())
}

#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = tx.send(path);
    });
    rx.await.ok().flatten().map(|path| path.to_string())
}

#[tauri::command]
pub async fn save_dialog(app: tauri::AppHandle, default_name: String) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    rx.await.ok().flatten().map(|path| path.to_string())
}

#[tauri::command]
pub fn documents_dir(app: tauri::AppHandle) -> String {
    use tauri::Manager;
    app.path()
        .document_dir()
        .map(|dir| dir.to_string_lossy().to_string())
        .unwrap_or_default()
}
