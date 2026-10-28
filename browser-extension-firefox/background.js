// KeePassHTTP client (inlined from kph.js, ES modules are not available in
// Firefox event pages)
// KeePassHTTP client used by the popup and the background worker.
//
// Wire format (pfn/keepasshttp): every request is JSON over POST on
// 127.0.0.1:19455. `associate` shares a 256-bit AES key; afterwards every
// request carries a random 16-byte nonce, its encrypted copy as the verifier,
// and the payload fields encrypted with AES-256-CBC, IV = nonce.

const DEFAULT_ENDPOINT = 'http://127.0.0.1:19455/';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i++) {
        binary += String.fromCharCode(view[i]);
    }
    return btoa(binary);
}

function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

async function importKey(keyBytes) {
    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [
        'encrypt',
        'decrypt'
    ]);
}

async function encrypt(keyBytes, iv, text) {
    const key = await importKey(keyBytes);
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, encoder.encode(text)));
}

async function decrypt(keyBytes, iv, cipherBytes) {
    const key = await importKey(keyBytes);
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipherBytes));
}

class KeePassHttpError extends Error {
    constructor(message, requestType) {
        super(message);
        this.name = 'KeePassHttpError';
        this.requestType = requestType;
    }
}

class KeePassHttpClient {
    constructor(endpoint) {
        this.endpoint = endpoint || DEFAULT_ENDPOINT;
        this.keyBytes = null;
        this.id = null;
    }

    async load() {
        const stored = await chrome.storage.local.get(['kphKey', 'kphId', 'kphEndpoint']);
        if (stored.kphEndpoint) {
            this.endpoint = stored.kphEndpoint;
        }
        if (stored.kphKey) {
            this.keyBytes = fromBase64(stored.kphKey);
        }
        if (stored.kphId) {
            this.id = stored.kphId;
        }
        return this;
    }

    async persist() {
        await chrome.storage.local.set({
            kphKey: toBase64(this.keyBytes),
            kphId: this.id,
            kphEndpoint: this.endpoint
        });
    }

    async forget() {
        this.keyBytes = null;
        this.id = null;
        await chrome.storage.local.remove(['kphKey', 'kphId']);
    }

    async post(body) {
        let response;
        try {
            response = await fetch(this.endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (e) {
            throw new KeePassHttpError('The KeeWeb Next app is not reachable on ' + this.endpoint, body.RequestType);
        }
        if (!response.ok) {
            throw new KeePassHttpError('HTTP ' + response.status, body.RequestType);
        }
        const data = await response.json();
        if (!data || !data.Success) {
            throw new KeePassHttpError((data && data.Error) || 'The app rejected the request', body.RequestType);
        }
        return data;
    }

    async checkVerifier(data) {
        // the server proves it knows the shared key by encrypting its nonce
        if (!data.Nonce || !data.Verifier) {
            throw new KeePassHttpError('Response has no verifier', data.RequestType);
        }
        const plain = await decrypt(this.keyBytes, fromBase64(data.Nonce), fromBase64(data.Verifier));
        if (plain !== data.Nonce) {
            throw new KeePassHttpError('Response verifier does not match', data.RequestType);
        }
    }

    async associate() {
        const key = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(16));
        const nonceB64 = toBase64(nonce);
        const verifier = await encrypt(key, nonce, nonceB64);
        const data = await this.post({
            RequestType: 'associate',
            Key: toBase64(key),
            Nonce: nonceB64,
            Verifier: toBase64(verifier),
            TriggerUnlock: false,
            SortSelection: false
        });
        this.keyBytes = key;
        this.id = data.Id;
        await this.persist();
        await this.checkVerifier(data);
        return data;
    }

    async request(type, fields) {
        if (!this.keyBytes || !this.id) {
            throw new KeePassHttpError('Not associated with the app yet', type);
        }
        const nonce = crypto.getRandomValues(new Uint8Array(16));
        const nonceB64 = toBase64(nonce);
        const verifier = await encrypt(this.keyBytes, nonce, nonceB64);
        const body = {
            RequestType: type,
            Id: this.id,
            Nonce: nonceB64,
            Verifier: toBase64(verifier),
            TriggerUnlock: false,
            SortSelection: false
        };
        for (const [name, value] of Object.entries(fields || {})) {
            body[name] = toBase64(await encrypt(this.keyBytes, nonce, value));
        }
        const data = await this.post(body);
        await this.checkVerifier(data);
        return data;
    }

    async testAssociate() {
        const data = await this.request('test-associate');
        return data.Hash;
    }

    async getLogins(url) {
        const data = await this.request('get-logins', { Url: url });
        const iv = fromBase64(data.Nonce);
        const entries = [];
        for (const entry of data.Entries || []) {
            entries.push({
                name: await decrypt(this.keyBytes, iv, fromBase64(entry.Name)),
                login: await decrypt(this.keyBytes, iv, fromBase64(entry.Login)),
                password: await decrypt(this.keyBytes, iv, fromBase64(entry.Password)),
                uuid: await decrypt(this.keyBytes, iv, fromBase64(entry.Uuid))
            });
        }
        return entries;
    }

    async setLogin(url, login, password) {
        return this.request('set-login', { Url: url, Login: login, Password: password });
    }
}

const __unused = null;


const client = new KeePassHttpClient();
let loaded = client.load();

async function ready() {
    await loaded;
    return client;
}

async function status() {
    await ready();
    if (!client.id) {
        return { associated: false };
    }
    try {
        const hash = await client.testAssociate();
        return { associated: true, hash };
    } catch (e) {
        return { associated: false, error: e.message };
    }
}

async function associate() {
    await ready();
    try {
        await client.associate();
        return { associated: true };
    } catch (e) {
        return { associated: false, error: e.message };
    }
}

async function getLogins(url) {
    await ready();
    return client.getLogins(url);
}

async function saveLogin(url, username, password) {
    await ready();
    await client.setLogin(url, username || '', password || '');
}

async function sendToTab(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
        // the content script is not injected on privileged pages; fall back
        // to a one-off script
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (payload) => window.__keewebNextFill && window.__keewebNextFill(payload),
            args: [message]
        });
        return result && result.result;
    }
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handlers = {
        status,
        associate: () => associate(),
        'get-logins': () => getLogins(message.url),
        'page-logins': () => getLogins(message.url),
        'save-login': () => saveLogin(message.url, message.username, message.password),
        forget: async () => {
            await ready();
            await client.forget();
            return { associated: false };
        },
        fill: () =>
            sendToTab(message.tabId, {
                type: 'fill',
                username: message.username,
                password: message.password
            }),
        'read-credentials': () => sendToTab(message.tabId, { type: 'read-credentials' })
    };
    const handler = handlers[message.type];
    if (!handler) {
        sendResponse({ error: 'unknown message ' + message.type });
        return false;
    }
    Promise.resolve(handler())
        .then((result) => sendResponse({ result }))
        .catch((e) => sendResponse({ error: e.message || String(e) }));
    return true;
});
