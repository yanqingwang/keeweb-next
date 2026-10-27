// The desktop form is the Tauri webview shell; it exposes window.__TAURI__
// before any app script runs. Everything else is the plain browser build.
let Launcher;

if (window.__TAURI__) {
    Launcher = require('./launcher-tauri').Launcher;
}

export { Launcher };
