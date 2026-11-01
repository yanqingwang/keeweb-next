//! Endpoint file shared by the app and the native-messaging helper.
//!
//! The app listens on a random loopback TCP port; the helper reads the port
//! and a one-time token from this file. A TCP loopback socket works the same
//! on Linux, macOS and Windows, where Unix sockets and named pipes differ.
//! The file lives in a user-private directory (0700) and is written 0600 on
//! Unix, so other local users cannot read the token.
#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};

fn uid() -> Option<u32> {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
}

fn private_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join("Library/Application Support/KeeWeb Next/browser");
    }
    #[cfg(target_os = "windows")]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(base).join("KeeWeb Next").join("browser");
    }
    // The fallback used to be a fixed path under the temporary directory, which
    // any local user can pre-create and then own. The home directory is the
    // only location that reliably belongs to the user running this app.
    if let Some(base) = std::env::var_os("XDG_STATE_HOME") {
        return PathBuf::from(base).join("keeweb-next").join("browser");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("state")
            .join("keeweb-next")
            .join("browser");
    }
    std::env::temp_dir().join(format!("keeweb-next-{}", uid().unwrap_or(1000)))
}

pub fn endpoint_path() -> PathBuf {
    if let Some(path) = std::env::var_os("KEEWEB_BROWSER_ENDPOINT") {
        return PathBuf::from(path);
    }
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("keeweb-next-browser.json");
    }
    private_dir().join("endpoint.json")
}

/// Creates the endpoint directory and restricts it to the current user.
///
/// The mode change is unconditional and its error is returned: only the owner
/// of a directory may chmod it, so a directory planted by another local user
/// fails here instead of being trusted.
pub fn prepare_dir(path: &Path) -> std::io::Result<()> {
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // create_dir_all follows a symlink, so the check has to look at the
        // link itself before the chmod lands somewhere else
        let meta = std::fs::symlink_metadata(dir)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(std::io::Error::other(
                "endpoint directory is not a plain directory",
            ));
        }
        if let Some(uid) = uid() {
            use std::os::unix::fs::MetadataExt;
            if meta.uid() != uid {
                return Err(std::io::Error::other(
                    "endpoint directory belongs to another user",
                ));
            }
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Publishes the listening port and token for the helper.
pub fn write_endpoint(path: &Path, port: u16, token: &str) -> std::io::Result<()> {
    prepare_dir(path)?;
    let body = serde_json::to_vec(&serde_json::json!({ "port": port, "token": token }))
        .map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // the file is ours and 0600 from the first byte; a pre-planted
        // symlink makes create_new fail instead of redirecting the token
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(&body)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

/// Reads the endpoint published by a running app.
pub fn read_endpoint(path: &Path) -> Option<(u16, String)> {
    // never follow a link: the helper must read the file the app wrote
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let body = std::fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let port = value.get("port")?.as_u64()? as u16;
    let token = value.get("token")?.as_str()?.to_string();
    Some((port, token))
}
