import { KeePassHttpClient } from './kph.js';

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handlers = {
        status,
        associate: () => associate(),
        'get-logins': () => getLogins(message.url),
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
