//! Socket location shared by the app and the native-messaging helper.
//!
//! Both processes must compute the same path, but the helper must not link the
//! Tauri library just for that (it would grow from ~600 KB to the size of the
//! whole app). This file is compiled twice, once per binary, via `#[path]`.

use std::path::{Path, PathBuf};

fn uid() -> u32 {
    // avoid pulling the libc crate in for one call
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
        .unwrap_or(1000)
}

/// A directory only this user can reach. Never the shared temp dir itself:
/// the socket belongs to one user, and taking ownership of `/tmp` (chmod 0700)
/// is both impossible and destructive — it is what silently disabled the
/// bridge on macOS, where `XDG_RUNTIME_DIR` does not exist.
fn private_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join("Library/Application Support/KeeWeb Next/browser");
    }
    std::env::temp_dir().join(format!("keeweb-next-{}", uid()))
}

pub fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("KEEWEB_BROWSER_SOCKET") {
        return PathBuf::from(path);
    }
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("keeweb-next-browser.sock");
    }
    private_dir().join("browser.sock")
}

/// Creates the socket directory with 0700 permissions.
///
/// Only the app calls this; the helper just connects, hence the allow.
///
/// Only the directory this module picked is touched, so a failure here can no
/// longer be caused by permissions on a directory we do not own.
#[allow(dead_code)]
pub fn prepare_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let Some(dir) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(dir)?;
    let mut perms = std::fs::metadata(dir)?.permissions();
    if perms.mode() & 0o077 != 0 {
        perms.set_mode(0o700);
        std::fs::set_permissions(dir, perms)?;
    }
    Ok(())
}
