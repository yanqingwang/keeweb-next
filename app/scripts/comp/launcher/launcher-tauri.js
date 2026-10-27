// The Tauri webview launcher. Implements the slice of the Launcher API the
// UI uses on the desktop: window controls for the custom titlebar. Vault
// storage goes through the storage backends (WebDAV via the shell command),
// so no filesystem methods are needed yet.
import { invoke } from 'util/tauri';

const Launcher = {
    name: 'webview-shell',
    version: '1.0.0',
    autoTypeSupported: false,
    thirdPartyStoragesSupported: true,
    clipboardSupported: true,
    devTools: true,

    platform() {
        if (navigator.platform.indexOf('Mac') >= 0) return 'darwin';
        if (navigator.platform.indexOf('Win') >= 0) return 'win32';
        return 'linux';
    },
    arch() {
        return navigator.userAgent.indexOf('arm') >= 0 ? 'arm64' : 'x64';
    },

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

    loadConfig(key) {
        return invoke('config_load', { key }).catch(() => null);
    },

    saveConfig(key, data) {
        return invoke('config_save', { key, data }).catch(() => {});
    }
};

export { Launcher };
