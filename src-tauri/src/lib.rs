pub mod webdav;

use webdav::{WebDavRequest, WebDavResponse};

/// Talks to a WebDAV server for the web UI.
///
/// The browser build has to use XHR, which the browser subjects to CORS;
/// WebDAV servers such as Nutstore (dav.jianguoyun.com) do not send the
/// headers that would allow it. The webview shell sends the same request
/// through reqwest instead, so a database on WebDAV can be opened and saved
/// without a proxy.
#[tauri::command]
async fn webdav_request(request: WebDavRequest) -> Result<WebDavResponse, String> {
    webdav::perform(request).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![webdav_request])
        .run(tauri::generate_context!())
        .expect("failed to run the KeeWeb shell");
}
