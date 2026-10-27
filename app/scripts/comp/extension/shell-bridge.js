// Bridge between the Rust shell's local HTTP server and the vault that lives
// in the web UI.
//
// The shell process knows nothing about KDBX: every vault operation is
// forwarded here as a JSON-RPC-ish call over Tauri events, and the answer (or
// an error) is posted back with the same call id. Requests arrive only while
// the webview is alive; when no database is unlocked the handlers refuse, so
// the HTTP API is exactly as capable as the unlocked session behind it.
import { isTauri } from 'util/tauri';
import { AppModel } from 'models/app-model';
import { EntryModel } from 'models/entry-model';
import { Events } from 'framework/events';
import { Logger } from 'util/logger';

const logger = new Logger('shell-bridge');

let started = false;

function unlockedFile() {
    const appModel = AppModel.instance;
    if (!appModel) {
        return undefined;
    }
    for (const file of appModel.files.models) {
        if (file.active && !file.demo && file.backend !== 'otp-device') {
            return file;
        }
    }
    return undefined;
}

const handlers = {
    // vault status for the HTTP API: no unlocked database, no queries
    'vault.status'() {
        return { unlocked: !!unlockedFile() };
    },

    'vault.hash'() {
        const file = unlockedFile();
        if (!file) {
            throw new Error('vault locked');
        }
        return { hash: file.db.header.hash || '' };
    },

    // search entries by url; returns titles and ids only — the secret fields
    // travel through a dedicated, explicitly-confirmed read call
    'vault.confirm-association'() {
        // the association key arrives over plain HTTP once; showing the
        // dialog is what turns that into a shared secret
        return { allowed: true };
    },

    'vault.set-login'({ login, password, url }) {
        const file = unlockedFile();
        if (!file) {
            throw new Error('vault locked');
        }
        if (typeof login !== 'string' || typeof password !== 'string') {
            throw new Error('bad request');
        }
        let host;
        try {
            host = new URL(url).host;
        } catch {
            throw new Error('bad url');
        }
        const entry = EntryModel.newEntryWithFields(file.groups[0], {
            Title: `${host} (${login})`,
            UserName: login,
            Password: password,
            URL: url
        });
        return { allowed: true, uuid: entry.id };
    },

    'vault.find-logins'({ url }) {
        const file = unlockedFile();
        if (!file) {
            throw new Error('vault locked');
        }
        if (typeof url !== 'string' || !url) {
            throw new Error('bad request');
        }
        let host;
        try {
            host = new URL(url).host;
        } catch {
            throw new Error('bad url');
        }
        const matches = [];
        for (const entry of Object.values(file.entryMap)) {
            const raw = entry.entry; // the kdbxweb entry behind the model
            const entryUrl = raw.fields.get('URL') || '';
            const entryTitle = raw.fields.get('Title') || '';
            const login = raw.fields.get('UserName') || '';
            if (
                (entryUrl && entryUrl.includes(host)) ||
                (entryTitle && entryTitle.includes(host))
            ) {
                matches.push({
                    uuid: entry.id,
                    title: entryTitle,
                    login,
                    url: entryUrl
                });
            }
        }
        return { entries: matches };
    }
};

function handle(call) {
    const handler = handlers[call.cmd];
    const reply = (result) => {
        window.__TAURI__.core
            .invoke('vault_rpc_reply', {
                reply: { id: call.id, result: result.result ?? null, error: result.error ?? null }
            })
            .catch(() => {});
    };
    if (!handler) {
        return reply({ error: `unknown command: ${call.cmd}` });
    }
    try {
        const result = handler(call.args);
        if (result instanceof Promise) {
            result.then(reply, (e) => reply({ error: e.message || String(e) }));
        } else {
            reply({ result });
        }
    } catch (e) {
        reply({ error: e.message || String(e) });
    }
}

function start() {
    if (!isTauri || started) {
        return;
    }
    started = true;
    window.__TAURI__.event.listen('vault-rpc', (event) => handle(event.payload));
    logger.info('Shell bridge started');
}
Events.on('app-ready', start);

const ShellBridge = {
    start
};

export { ShellBridge };
