use std::collections::HashMap;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// A database is small compared to the files a browser handles, and the whole
/// body already crossed the IPC boundary once. The cap stops a malicious or
/// broken server from asking the shell to hold an unbounded blob.
const MAX_BODY: usize = 512 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// Methods a WebDAV client needs. Anything else is refused rather than
/// forwarded, so the command cannot become a generic HTTP proxy.
const ALLOWED_METHODS: &[&str] = &[
    "GET", "HEAD", "PUT", "POST", "DELETE", "MOVE", "COPY", "MKCOL", "PROPFIND", "OPTIONS",
];

#[derive(Debug, Deserialize)]
pub struct WebDavRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// base64, because the IPC channel carries JSON
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WebDavResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    /// base64, because the IPC channel carries JSON
    pub body: String,
}

pub async fn perform(request: WebDavRequest) -> Result<WebDavResponse, String> {
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| format!("invalid HTTP method: {}", request.method))?;
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!("HTTP method is not allowed: {}", method));
    }

    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("invalid URL: {}", e))?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("unsupported URL scheme: {}", scheme)),
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("KeeWeb-Next/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("failed to build the HTTP client: {}", e))?;

    let mut builder = client.request(method.clone(), url);
    for (name, value) in &request.headers {
        // framing headers describe the browser's connection, not the new one
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host" | "content-length" | "connection" | "transfer-encoding"
        ) {
            continue;
        }
        builder = builder.header(name, value);
    }

    if let Some(body) = request.body {
        let bytes = STANDARD
            .decode(body)
            .map_err(|e| format!("request body is not base64: {}", e))?;
        if bytes.len() > MAX_BODY {
            return Err("request body is too large".to_string());
        }
        builder = builder.body(bytes);
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("{} {} failed: {}", method, request.url, e))?;

    let status = response.status().as_u16();
    let mut headers = HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_string(), value.to_string());
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("failed to read the response: {}", e))?;
    if bytes.len() > MAX_BODY {
        return Err("response body is too large".to_string());
    }

    Ok(WebDavResponse {
        status,
        headers,
        body: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, url: &str) -> WebDavRequest {
        WebDavRequest {
            method: method.to_string(),
            url: url.to_string(),
            headers: HashMap::new(),
            body: None,
        }
    }

    #[tokio::test]
    async fn refuses_a_method_outside_the_webdav_set() {
        let err = perform(request("TRACE", "https://example.org/db.kdbx"))
            .await
            .unwrap_err();
        assert!(err.contains("not allowed"), "unexpected error: {}", err);
    }

    #[tokio::test]
    async fn refuses_a_non_http_url() {
        let err = perform(request("GET", "file:///etc/passwd"))
            .await
            .unwrap_err();
        assert!(err.contains("scheme"), "unexpected error: {}", err);
    }

    #[tokio::test]
    async fn refuses_a_body_that_is_not_base64() {
        let mut req = request("PUT", "https://example.org/db.kdbx");
        req.body = Some("not base64!".to_string());
        let err = perform(req).await.unwrap_err();
        assert!(err.contains("base64"), "unexpected error: {}", err);
    }
}
