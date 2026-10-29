//! Endpoint file shared by the app and the native-messaging helper.
//!
//! The app listens on a random loopback TCP port; the helper reads the port
//! and a one-time token from this file. A TCP loopback socket works the same
//! on Linux, macOS and Windows, where Unix sockets and named pipes differ.
//! The file lives in a user-private directory (0700) and is written 0600 on
//! Unix, so other local users cannot read the token.
#![allow(dead_code)]


use std::path::{Path, PathBuf};

fn uid() -> u32 {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
        .unwrap_or(1000)
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
    std::env::temp_dir().join(format!("keeweb-next-{}", uid()))
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
pub fn prepare_dir(path: &Path) -> std::io::Result<()> {
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dir)?.permissions();
        if perms.mode() & 0o077 != 0 {
            perms.set_mode(0o700);
            std::fs::set_permissions(dir, perms)?;
        }
    }
    Ok(())
}

/// Publishes the listening port and token for the helper.
pub fn write_endpoint(path: &Path, port: u16, token: &str) -> std::io::Result<()> {
    prepare_dir(path)?;
    let body = serde_json::json!({ "port": port, "token": token });
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec(&body).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

/// Reads the endpoint published by a running app.
pub fn read_endpoint(path: &Path) -> Option<(u16, String)> {
    let body = std::fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let port = value.get("port")?.as_u64()? as u16;
    let token = value.get("token")?.as_str()?.to_string();
    Some((port, token))
}
