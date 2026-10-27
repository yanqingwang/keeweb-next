// The Electron build hosted a separate Node process for Argon2, the keyboard
// emulation used by auto-type, and YubiKey access. The webview shell does not:
// Argon2 runs in WebAssembly, and the desktop-only features are off. The
// object keeps the API the rest of the app imports, so no feature probes have
// to change, and every call either does nothing or fails in the open rather
// than pretending to have done the work.
const unsupported = (what) => () => Promise.reject(new Error(`${what} is not supported`));

const NativeModules = {
    startHost: () => Promise.resolve(),
    hostError: () => {},
    hostDisconnect: () => {},
    hostExit: () => {},
    hostCallback: () => {},
    log: () => {},
    autoRestartHost: () => {},
    call: unsupported('native modules'),
    callNoWait: unsupported('native modules'),

    startUsbListener: () => {},
    stopUsbListener: () => {},
    getYubiKeys: () => Promise.resolve([]),
    yubiKeyChallengeResponse: (yubiKey, challenge, slot, callback) =>
        callback(new Error('YubiKey challenge-response is not supported')),
    yubiKeyCancelChallengeResponse: () => {},

    argon2: unsupported('native Argon2'),
    hardwareCryptoDeleteKey: async () => {},
    hardwareEncrypt: unsupported('hardware encryption'),
    hardwareDecrypt: unsupported('hardware decryption'),

    kbdGetActiveWindow: unsupported('keyboard emulation'),
    kbdGetActivePid: unsupported('keyboard emulation'),
    kbdShowWindow: unsupported('keyboard emulation'),
    kbdText: unsupported('keyboard emulation'),
    kbdTextAsKeys: unsupported('keyboard emulation'),
    kbdKeyPress: unsupported('keyboard emulation'),
    kbdShortcut: unsupported('keyboard emulation'),
    kbdKeyMoveWithModifier: unsupported('keyboard emulation'),
    kbdKeyPressWithCharacter: unsupported('keyboard emulation'),
    kbdEnsureModifierNotPressed: unsupported('keyboard emulation')
};

export { NativeModules };
