#[cfg(unix)]
mod host {

//! Native messaging host for KeePassXC-Browser.
//!
//! The browser starts this helper when the extension opens its native port.
//! Messages arrive on stdin as a 4-byte little-endian length followed by JSON;
//! each one is forwarded, newline-delimited, to the running KeeWeb Next app
//! over its Unix socket, and the answer goes back the same way.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("KEEWEB_BROWSER_SOCKET") {
        return PathBuf::from(path);
    }
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("keeweb-next-browser.sock");
    }
    let uid = std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok())
        .unwrap_or(1000);
    PathBuf::from(format!("/tmp/keeweb-next-{}-browser.sock", uid))
}

fn read_message<R: Read>(reader: &mut R) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).ok()?;
    let size = u32::from_le_bytes(len) as usize;
    if size == 0 || size > 8 * 1024 * 1024 {
        return None;
    }
    let mut body = vec![0u8; size];
    reader.read_exact(&mut body).ok()?;
    Some(body)
}

fn write_message<W: Write>(writer: &mut W, body: &[u8]) {
    let len = (body.len() as u32).to_le_bytes();
    let _ = writer.write_all(&len);
    let _ = writer.write_all(body);
    let _ = writer.flush();
}

fn connect() -> Option<UnixStream> {
    let path = socket_path();
    for _ in 0..20 {
        if let Ok(stream) = UnixStream::connect(&path) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(130)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
            return Some(stream);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

pub fn main() {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut output = std::io::stdout();

    while let Some(body) = read_message(&mut input) {
        let action = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("action").and_then(|a| a.as_str()).map(str::to_string))
            .unwrap_or_default();

        let Some(mut socket) = connect() else {
            let error = serde_json::json!({
                "action": action,
                "error": "KeeWeb Next is not running",
                "errorCode": 0
            });
            write_message(&mut output, error.to_string().as_bytes());
            continue;
        };

        if socket.write_all(&body).is_err() || socket.write_all(b"\n").is_err() {
            continue;
        }
        let _ = socket.flush();

        let mut reader = std::io::BufReader::new(socket);
        let mut line = String::new();
        use std::io::BufRead;
        if reader.read_line(&mut line).is_err() || line.is_empty() {
            let error = serde_json::json!({
                "action": action,
                "error": "the app closed the connection",
                "errorCode": 0
            });
            write_message(&mut output, error.to_string().as_bytes());
            continue;
        }
        write_message(&mut output, line.trim_end().as_bytes());
    }
}


}

#[cfg(unix)]
fn main() {
    host::main();
}

#[cfg(not(unix))]
fn main() {
    eprintln!("keeweb-next-browser-host is only supported on Linux and macOS");
    std::process::exit(1);
}
