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
import { Alerts } from 'comp/ui/alerts';
import { Locale } from 'util/locale';
import { Logger } from 'util/logger';

const logger = new Logger('shell-bridge');

let started = false;

function unlockedFile() {
    const appModel = AppModel.instance;
    if (!appModel) {
        return undefined;
    }
    for (const file of appModel.files) {
        if (file.active && !file.demo && file.backend !== 'otp-device') {
            return file;
        }
    }
    return undefined;
}

function hostOf(rawUrl) {
    if (!rawUrl) {
        return '';
    }
    try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : 'https://' + rawUrl);
        return parsed.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }
}

function hostMatches(entryHost, targetHost) {
    if (!entryHost) {
        return false;
    }
    return (
        entryHost === targetHost ||
        entryHost.endsWith('.' + targetHost) ||
        targetHost.endsWith('.' + entryHost)
    );
}

function allEntries(file) {
    const entries = [];
    // walk the live model, not file.entryMap: entries added by the extension
    // or by the user after the file was opened are not in that snapshot
    file.forEachEntry({ includeDisabled: true }, (entry) => entries.push(entry));
    return entries;
}

function toVaultEntry(entry) {
    return {
        uuid: entry.uuid,
        title: entry.title || '',
        login: entry.user || '',
        password: entry.password ? entry.password.getText() : ''
    };
}

const handlers = {
    // vault status for the HTTP API: no unlocked database, no queries
    'vault.status'() {
        return { unlocked: !!unlockedFile() };
    },

    async 'vault.hash'() {
        const file = unlockedFile();
        if (!file) {
            throw new Error('vault locked');
        }
        // KeePassHTTP identifies a database by SHA-1 over the root and
        // recycle-bin UUIDs, so extensions notice a database switch
        const root = file.db.getDefaultGroup().uuid.id;
        const recycle = file.db.meta.recycleBinUuid ? file.db.meta.recycleBinUuid.id : '';
        const digest = await crypto.subtle.digest(
            'SHA-1',
            new TextEncoder().encode(root + recycle)
        );
        const hash = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        return { hash };
    },

    // the association key arrives over plain HTTP once; showing the
    // dialog is what turns that into a shared secret
    'vault.confirm-association'() {
        const file = unlockedFile();
        if (!file) {
            return { allowed: false, unlocked: false };
        }
        return new Promise((resolve) => {
            Alerts.yesno({
                header: Locale.kphAssociationTitle,
                body: Locale.kphAssociationBody,
                icon: 'plug',
                complete: (result) => {
                    resolve({ allowed: result === 'yes', unlocked: true });
                }
            });
        });
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
        // newEntry marks the file modified; push it through the normal save
        // path so the login reaches WebDAV instead of living in memory only
        const appModel = AppModel.instance;
        if (appModel && file.storage) {
            setTimeout(() => appModel.syncFile(file, {}, () => {}), 0);
        }
        return { allowed: true, unlocked: true, uuid: entry.id };
    },

    'vault.find-logins'({ url, submitUrl }) {
        const file = unlockedFile();
        if (!file) {
            throw new Error('vault locked');
        }
        if (typeof url !== 'string' || !url) {
            throw new Error('bad request');
        }
        const targets = [hostOf(url), submitUrl ? hostOf(submitUrl) : ''].filter(Boolean);
        if (!targets.length) {
            throw new Error('bad url');
        }
        const matches = [];
        for (const entry of allEntries(file)) {
            const entryHost = hostOf(entry.url);
            if (!targets.some((target) => hostMatches(entryHost, target))) {
                continue;
            }
            matches.push(toVaultEntry(entry));
        }
        return { allowed: true, unlocked: true, entries: matches };
    },

    'vault.all-logins'() {
        const file = unlockedFile();
        if (!file) {
            throw new Error('vault locked');
        }
        return {
            allowed: true,
            unlocked: true,
            entries: allEntries(file).map(toVaultEntry)
        };
    },

    'vault.find-by-names'({ names }) {
        const file = unlockedFile();
        if (!file) {
            throw new Error('vault locked');
        }
        const wanted = new Set((names || []).map((name) => String(name).toLowerCase()));
        const entries = [];
        for (const entry of allEntries(file)) {
            if (wanted.has((entry.title || '').toLowerCase())) {
                entries.push(toVaultEntry(entry));
            }
        }
        return { allowed: true, unlocked: true, entries };
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
            result.then(
                (value) => reply({ result: value }),
                (e) => reply({ error: e.message || String(e) })
            );
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
