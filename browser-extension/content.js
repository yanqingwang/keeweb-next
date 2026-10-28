// Form filling and credential reading for the KeeWeb Next extension.

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
    // the field right before the password box is the usual layout
    const position = candidates.indexOf(passwordField);
    const before = candidates.filter(
        (el) => passwordField.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING
    );
    return before[before.length - 1] || candidates[position - 1] || null;
}

function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fill({ username, password }) {
    const passwordField = passwordFields()[0];
    if (!passwordField) {
        return { filled: false, reason: 'no password field on this page' };
    }
    if (password) {
        setValue(passwordField, password);
    }
    if (username) {
        const userField = usernameFieldNear(passwordField);
        if (userField) {
            setValue(userField, username);
        }
    }
    passwordField.focus();
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