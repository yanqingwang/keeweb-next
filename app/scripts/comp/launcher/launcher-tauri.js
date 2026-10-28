// The Tauri webview launcher: the slice of the Electron Launcher API that the
// app touches, so desktop code paths run instead of crashing. There is no Node
// process here, so the Node-backed features (auto-type, native modules,
// updater, local file storage) report themselves as unsupported rather than
// failing halfway through a feature.
import { invoke } from 'util/tauri';

const noop = () => {};

const Launcher = {
    name: 'webview-shell',
    version: '1.0.0',
    autoTypeSupported: false,
    thirdPartyStoragesSupported: true,
    clipboardSupported: true,
    // local file storage needs a native file backend; the shell opens
    // databases over WebDAV/http for now
    fileStorageSupported: false,
    updaterEnabled: () => false,
    devTools: true,
    exitRequested: false,
    restartPending: false,

    platform() {
        if (navigator.platform.indexOf('Mac') >= 0) return 'darwin';
        if (navigator.platform.indexOf('Win') >= 0) return 'win32';
        return 'linux';
    },

    arch() {
        return navigator.userAgent.indexOf('arm') >= 0 ? 'arm64' : 'x64';
    },

    getAppPath: () => '',
    isAppFocused: () => document.hasFocus(),
    showMainWindow: noop,
    hideApp: noop,
    minimizeApp: noop,
    openDevTools: noop,
    setGlobalShortcuts: noop,
    preventExit: noop,
    exit: noop,
    requestRestartAndUpdate: noop,

    openLink(href) {
        if (/^(http|https|ftp|sftp|mailto):/i.test(href)) {
            window.open(href, '_blank');
        }
    },

    minimizeMainWindow() {
        invoke('window_minimize').catch(() => {});
    },

    maximizeMainWindow() {
        invoke('window_toggle_maximize').catch(() => {});
    },

    restoreMainWindow() {
        invoke('window_toggle_maximize').catch(() => {});
    },

    mainWindowMaximized() {
        return false;
    },

    setClipboardText(text) {
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    },
    getClipboardText: () => '',
    clearClipboardText: noop,

    loadConfig(key) {
        return invoke('config_load', { key }).catch(() => null);
    },

    saveConfig(key, data) {
        return invoke('config_save', { key, data }).catch(() => {});
    },

    // Node-only capabilities: callers either check the flags above or are
    // protected by them, so these exist only to keep the API shape.
    req: () => {
        throw new Error('native node modules are not available in the webview shell');
    },
    remoteApp: () => ({}),
    resolveProxy: (url, callback) => callback && callback(null),
    spawn: () => ({ on: noop, kill: noop, stdout: { on: noop }, stderr: { on: noop } }),
    openFileChooser: noop,
    getSaveFileName: noop,
    getUserDataPath: () => '',
    getTempPath: () => '',
    joinPath: (a, b) => [a, b].filter(Boolean).join('/').replace(/\/+/g, '/'),
    parsePath: (p) => ({
        dir: p.replace(/\/[^/]*$/, ''),
        name: p.split('/').pop()
    }),
    createFsWatcher: () => ({ close: noop }),
    fileExists: () => false,
    statFile: noop,
    readFile: noop,
    writeFile: noop,
    mkdir: noop,
    deleteFile: noop
};

export { Launcher };
