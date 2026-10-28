// The Tauri webview launcher: the slice of the Electron Launcher API that the
// app touches, so desktop code paths run instead of crashing. There is no Node
// process here, so the Node-backed features (auto-type, native modules,
// updater, local file storage) report themselves as unsupported rather than
// failing halfway through a feature.
import { invoke } from 'util/tauri';

const noop = () => {};

const bytesToBase64 = (bytes) => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
};

const base64ToBytes = (encoded) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

const toBytes = (data) => {
    if (typeof data === 'string') {
        return new TextEncoder().encode(data);
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data);
};

// filled on startup so the synchronous path callers have a value
let documentsDir = '';
let dataDir = '';

const Launcher = {
    name: 'webview-shell',
    version: '1.0.0',
    autoTypeSupported: false,
    // USB devices and YubiKeys need native modules and the ykman CLI, neither
    // of which exists in the webview shell; the devices settings stay hidden
    devicesSupported: false,
    thirdPartyStoragesSupported: true,
    clipboardSupported: true,
    // local file storage needs a native file backend; the shell opens
    // databases over WebDAV/http for now
    fileStorageSupported: false,
    updaterEnabled: () => false,
    // the release build ships without devtools; the settings entry is hidden
    devTools: false,
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
    getDocumentsPath: (name) => [documentsDir, name].filter(Boolean).join('/').replace(/\/+/g, '/'),
    // no power monitor in the webview; the setting that depends on it stays
    // hidden instead of crashing the general page
    canDetectOsSleep: () => false,
    isAppFocused: () => document.hasFocus(),
    // browser requests need this window in front to be answered
    showMainWindow: () => {
        invoke('window_focus').catch(noop);
    },
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

    // file dialogs: the picker resolves a path, and the caller gets a File
    // object because the open view feeds it to a FileReader
    openFileChooser(callback) {
        invoke('pick_file')
            .then(async (path) => {
                if (!path) {
                    return;
                }
                try {
                    const data = await invoke('file_read', { path });
                    const name = path.split('/').pop();
                    const file = new File([base64ToBytes(data)], name, {
                        type: 'application/octet-stream'
                    });
                    file.path = path;
                    callback(null, file);
                } catch (e) {
                    callback(e);
                }
            })
            .catch(callback);
    },

    getSaveFileName(defaultName, callback) {
        invoke('save_dialog', { defaultName })
            .then((path) => path && callback(path))
            .catch(noop);
    },
    getUserDataPath: (name) => [dataDir, name].filter(Boolean).join('/').replace(/\/+/g, '/'),
    getUserDataPathAsync(name) {
        return invoke('data_dir').then((dir) =>
            [dir, name].filter(Boolean).join('/').replace(/\/+/g, '/')
        );
    },
    getTempPath: () => '',
    joinPath: (a, b) => [a, b].filter(Boolean).join('/').replace(/\/+/g, '/'),
    parsePath: (p) => ({
        dir: p.replace(/\/[^/]*$/, ''),
        name: p.split('/').pop()
    }),
    // no fs.watch equivalent is wired up yet: a local file is re-read when it
    // is opened again, external edits are not picked up live
    createFsWatcher: () => ({ close: noop }),
    fileExistsSync: () => false,

    fileExists(path, callback) {
        invoke('file_exists', { path })
            .then((exists) => callback(exists))
            .catch(() => callback(false));
    },

    statFile(path, callback) {
        invoke('file_stat', { path })
            .then((stat) =>
                callback({
                    size: stat.size,
                    mtime: new Date(stat.mtime_ms),
                    isDir: stat.is_dir,
                    uid: stat.uid
                })
            )
            .catch((err) => callback(undefined, err));
    },

    readFile(path, opts, callback) {
        const cb = callback || opts;
        invoke('file_read', { path })
            .then((data) => cb(base64ToBytes(data)))
            .catch((err) => cb(undefined, err));
    },

    writeFile(path, data, callback) {
        invoke('file_write', { path, data: bytesToBase64(toBytes(data)) })
            .then(() => callback && callback())
            .catch((err) => callback && callback(err));
    },

    mkdir(path, callback) {
        invoke('dir_create', { path })
            .then(() => callback && callback())
            .catch((err) => callback && callback(err));
    },

    deleteFile(path, callback) {
        invoke('file_delete', { path })
            .then(() => callback && callback())
            .catch((err) => callback && callback(err));
    }
};

invoke('documents_dir')
    .then((dir) => {
        documentsDir = dir || '';
    })
    .catch(noop);

invoke('data_dir')
    .then((dir) => {
        dataDir = dir || '';
    })
    .catch(noop);

export { Launcher };
