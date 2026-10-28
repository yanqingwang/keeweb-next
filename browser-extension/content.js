// Form filling, credential reading, and the inline autofill menu.
//
// The popup can fill on demand, but the useful flow is the one every password
// manager has: focus a login field and pick a saved login. The menu lives in a
// shadow root so page CSS cannot touch it, and passwords stay in this isolated
// closure until the user clicks an entry.

const ICON_SIZE = 20;

let menu = null;
let menuHost = null;
let menuEntries = [];
let activeField = null;
let cache = { url: null, at: 0, entries: [] };

function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
}

function passwordFields() {
    return [...document.querySelectorAll('input[type="password"]')].filter(isVisible);
}

function usernameFieldNear(passwordField) {
    const scope = passwordField.form || document;
    const candidates = [
        ...scope.querySelectorAll(
            'input[type="text"], input[type="email"], input:not([type])'
        )
    ].filter(isVisible);
    const byAutocomplete = candidates.find((el) => {
        const hint = (el.getAttribute('autocomplete') || '').toLowerCase();
        return hint === 'username' || hint === 'email';
    });
    if (byAutocomplete) {
        return byAutocomplete;
    }
    const position = candidates.indexOf(passwordField);
    const before = candidates.filter(
        (el) => passwordField.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING
    );
    return before[before.length - 1] || candidates[position - 1] || null;
}

function passwordFieldNear(usernameField) {
    const fields = passwordFields();
    return fields.find(
        (el) => usernameField.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
    );
}

function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillInto(field, { username, password }) {
    const passwordField = field.type === 'password' ? field : passwordFieldNear(field) || passwordFields()[0];
    const userField = field.type === 'password' ? usernameFieldNear(field) : field;
    if (userField && username) {
        setValue(userField, username);
    }
    if (passwordField && password) {
        setValue(passwordField, password);
    }
    (passwordField || userField).focus();
}

function fill(payload) {
    const passwordField = passwordFields()[0];
    if (!passwordField) {
        return { filled: false, reason: 'no password field on this page' };
    }
    fillInto(passwordField, { username: payload.username, password: payload.password });
    return { filled: true };
}

function readCredentials() {
    const passwordField = passwordFields()[0];
    if (!passwordField) {
        return { found: false };
    }
    const userField = usernameFieldNear(passwordField);
    return {
        found: true,
        username: userField ? userField.value : '',
        password: passwordField.value,
        url: location.href
    };
}

function requestLogins() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'page-logins', url: location.href }, (response) => {
            if (chrome.runtime.lastError || !response || response.error) {
                resolve([]);
            } else {
                resolve(response.result || []);
            }
        });
    });
}

function destroyMenu() {
    if (menuHost && menuHost.parentNode) {
        menuHost.parentNode.removeChild(menuHost);
    }
    menuHost = null;
    menu = null;
    menuEntries = [];
}

function createMenu() {
    if (menuHost) {
        return menu;
    }
    menuHost = document.createElement('div');
    menuHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    const shadow = menuHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
        .panel {
            font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            min-width: 220px;
            max-width: 320px;
            background: #fff;
            color: #1b1b1b;
            border: 1px solid rgba(0,0,0,.14);
            border-radius: 8px;
            box-shadow: 0 10px 28px rgba(0,0,0,.22);
            overflow: hidden;
        }
        .item {
            display: flex; flex-direction: column; gap: 1px;
            padding: 8px 10px; cursor: pointer;
        }
        .item:hover, .item.active { background: #eef3ff; }
        .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .login { color: #666; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .hint { padding: 7px 10px; color: #777; font-size: 12px; }
    `;
    menu = document.createElement('div');
    menu.className = 'panel';
    shadow.append(style, menu);
    document.documentElement.appendChild(menuHost);
    return menu;
}

function positionMenu(field) {
    const rect = field.getBoundingClientRect();
    menuHost.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 330)) + 'px';
    menuHost.style.top = Math.min(rect.bottom + 4, window.innerHeight - 60) + 'px';
}

function renderMenu(field) {
    if (!menuEntries.length) {
        destroyMenu();
        return;
    }
    const panel = createMenu();
    panel.textContent = '';
    for (const entry of menuEntries) {
        const item = document.createElement('div');
        item.className = 'item';
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = entry.name || '(no title)';
        const login = document.createElement('div');
        login.className = 'login';
        login.textContent = entry.login;
        item.append(title, login);
        // keep the field focused while the menu is clicked
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', () => {
            // entries use the KeePassHTTP field name, the filler the DOM one
            fillInto(field, { username: entry.login, password: entry.password });
            destroyMenu();
        });
        panel.appendChild(item);
    }
    positionMenu(field);
}

async function onFieldFocus(field) {
    if (!field || (field.type !== 'password' && field.type !== 'text' && field.type !== 'email' && field.type)) {
        return;
    }
    if (field.type !== 'password' && !passwordFieldNear(field)) {
        return; // only login-ish text fields
    }
    activeField = field;
    const now = Date.now();
    if (cache.url !== location.href || now - cache.at > 60000) {
        cache = { url: location.href, at: now, entries: await requestLogins() };
    }
    if (activeField !== field) {
        return;
    }
    menuEntries = cache.entries;
    renderMenu(field);
}

function onDocumentFocusIn(e) {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) {
        return;
    }
    onFieldFocus(target).catch(() => {});
}

function onDocumentFocusOut() {
    setTimeout(() => {
        if (menuHost && !menuHost.contains(document.activeElement)) {
            destroyMenu();
        }
    }, 150);
}

function onKeyDown(e) {
    if (e.key === 'Escape') {
        destroyMenu();
    }
}

window.__keewebNextFill = fill;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'fill') {
        sendResponse(fill(message));
        return false;
    }
    if (message.type === 'read-credentials') {
        sendResponse(readCredentials());
        return false;
    }
    return false;
});

document.addEventListener('focusin', onDocumentFocusIn, true);
document.addEventListener('focusout', onDocumentFocusOut, true);
document.addEventListener('keydown', onKeyDown, true);
window.addEventListener('scroll', () => activeField && positionMenu(activeField), true);
window.addEventListener('resize', () => activeField && positionMenu(activeField));
