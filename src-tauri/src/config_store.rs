//! App settings persistence for the webview shell.
//!
//! The browser build keeps settings in localStorage; inside a shell that
//! would be wiped whenever the webview's data directory rotates. Settings go
//! to `config/<key>.json` under the OS app-data directory instead — same
//! split KeePass made between "app settings" and "per-file settings".

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Default)]
pub struct ConfigStore {
    dir: Mutex<Option<PathBuf>>,
}

impl ConfigStore {
    /// Resolves the directory lazily: the Tauri path resolver needs the app
    /// handle, which exists only after setup.
    pub fn init(&self, dir: PathBuf) {
        let _ = std::fs::create_dir_all(&dir);
        *self.dir.lock().expect("config dir lock") = Some(dir);
    }

    fn path(&self, key: &str) -> Option<PathBuf> {
        let key = sanitize(key)?;
        let dir = self.dir.lock().expect("config dir lock").clone()?;
        Some(dir.join(format!("{}.json", key)))
    }

    pub fn load(&self, key: &str) -> Option<String> {
        let path = self.path(key)?;
        std::fs::read_to_string(path).ok()
    }

    pub fn save(&self, key: &str, data: &str) -> Result<(), String> {
        let path = self.path(key).ok_or("config storage unavailable")?;
        // write to a temp file in the same directory and rename, so a crash
        // mid-write leaves the previous settings intact
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }
}

fn sanitize(key: &str) -> Option<String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 128 {
        return None;
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(key.to_string())
}

use std::sync::Arc;

pub struct State(pub Arc<ConfigStore>);

#[tauri::command]
pub fn config_load(
    key: String,
    store: tauri::State<'_, State>,
) -> Result<Option<String>, String> {
    Ok(store.0.load(&key))
}

#[tauri::command]
pub fn config_save(key: String, data: String, store: tauri::State<'_, State>) -> Result<(), String> {
    store.0.save(&key, &data)
}

/// Keys seen, for diagnostics; unused by the UI today.
pub type LoadedKeys = HashMap<String, String>;
