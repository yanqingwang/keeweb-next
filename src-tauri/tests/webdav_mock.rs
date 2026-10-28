use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use keeweb_next_lib::webdav::{perform, WebDavRequest};

/// One-shot HTTP server: answers the first request and hands the raw bytes
/// back to the test thread.
fn serve(response: &'static str) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buf = [0u8; 65536];
        let mut raw = Vec::new();
        loop {
            let read = stream.read(&mut buf).expect("read");
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&buf[..read]);
            let header_end = raw
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|p| p + 4);
            if let Some(header_end) = header_end {
                let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
                let len = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
                    .and_then(|l| l.split(':').nth(1))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if raw.len() >= header_end + len {
                    break;
                }
            }
        }
        stream.write_all(response.as_bytes()).expect("write");
        String::from_utf8_lossy(&raw).to_string()
    });
    (format!("http://{}", addr), handle)
}

#[tokio::test]
async fn a_put_carries_the_body_with_its_length() {
    let (url, handle) = serve("HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n");

    let body = STANDARD.encode(b"some database bytes");
    let response = perform(WebDavRequest {
        method: "PUT".to_string(),
        url,
        headers: [("Authorization".to_string(), "Basic dXNlcjpwYXNz".to_string())]
            .into_iter()
            .collect(),
        body: Some(body),
    })
    .await
    .expect("put");

    assert_eq!(response.status, 201);

    let raw = handle.join().expect("join");
    assert!(
        raw.starts_with("PUT /"),
        "unexpected request: {}",
        &raw[..40.min(raw.len())]
    );
    assert!(
        raw.to_ascii_lowercase().contains("content-length: 19"),
        "no content-length in:\n{}",
        raw
    );
    assert!(
        !raw.to_ascii_lowercase().contains("transfer-encoding: chunked"),
        "chunked in:\n{}",
        raw
    );
    assert!(
        raw.to_ascii_lowercase()
            .contains("authorization: basic dxnlcjpwyxnz"),
        "credentials missing in:\n{}",
        raw
    );
    assert!(raw.ends_with("some database bytes"), "body missing:\n{}", raw);
}

#[tokio::test]
async fn a_get_returns_the_body_and_headers() {
    let (url, handle) = serve(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 2\r\n\r\nok",
    );

    let response = perform(WebDavRequest {
        method: "GET".to_string(),
        url,
        headers: Default::default(),
        body: None,
    })
    .await
    .expect("get");

    assert_eq!(response.status, 200);
    assert_eq!(
        response.headers.get("content-type").map(String::as_str),
        Some("application/octet-stream")
    );
    assert_eq!(STANDARD.decode(&response.body).unwrap(), b"ok");

    let raw = handle.join().expect("join");
    assert!(raw.starts_with("GET /"), "unexpected request: {}", raw);
}

#[tokio::test]
async fn a_missing_last_modified_stays_missing() {
    // Nutstore answers HEAD without Last-Modified; the proxy must pass the
    // header set through unchanged so the web layer can decide what to do.
    let (url, handle) = serve("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");

    let response = perform(WebDavRequest {
        method: "HEAD".to_string(),
        url,
        headers: Default::default(),
        body: None,
    })
    .await
    .expect("head");

    assert_eq!(response.status, 200);
    assert!(
        !response.headers.contains_key("last-modified"),
        "unexpected last-modified in {:?}",
        response.headers
    );

    let raw = handle.join().expect("join");
    assert!(raw.starts_with("HEAD /"), "unexpected request: {}", raw);
}
