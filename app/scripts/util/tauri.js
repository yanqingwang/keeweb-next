// The webview shell injects `window.__TAURI__` before the app loads. In a
// plain browser it is absent, and the app keeps using the storage backends it
// always had.
const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;

const isTauri = !!tauri && !!tauri.core && typeof tauri.core.invoke === 'function';

function invoke(command, args) {
    return tauri.core.invoke(command, args);
}

export { isTauri, invoke };
