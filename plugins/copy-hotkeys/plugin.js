/**
 * KeeWeb plugin: copy-hotkeys
 *
 * Reads the currently selected entry and copies a field with Alt+1..4, which is
 * the KeePass habit for getting a value into the clipboard without opening the
 * details pane. Alt+Shift+U opens the entry URL in the system browser.
 *
 * @author Rossw
 * @license MIT
 */

const { Events } = require('framework/events');
const { CopyPaste } = require('comp/browser/copy-paste');

let currentEntry = null;
let visibleEntries = [];
let keyHandler = null;
let entryHandler = null;
let filterHandler = null;
let toastEl = null;
let toastTimer = null;

const FIELDS = {
    '1': { name: 'user', label: 'User', value: (e) => e.user },
    '2': {
        name: 'password',
        label: 'Password',
        value: (e) => (e.password ? e.password.getText() : '')
    },
    '3': { name: 'url', label: 'URL', value: (e) => e.url },
    '4': { name: 'title', label: 'Title', value: (e) => e.title }
};

function isEditable(el) {
    if (!el) {
        return false;
    }
    const tag = el.tagName;
    return (
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
    );
}

function selectedEntry() {
    return currentEntry || visibleEntries[0];
}

function showToast(text) {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'copy-hotkeys-toast';
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('copy-hotkeys-toast--visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl.classList.remove('copy-hotkeys-toast--visible');
    }, 1400);
}

function copyField(field) {
    const entry = selectedEntry();
    if (!entry) {
        showToast('No entry selected');
        return;
    }
    const value = field.value(entry);
    if (!value) {
        showToast(field.label + ' is empty');
        return;
    }
    const result = CopyPaste.copy(value);
    if (result && result.success) {
        const seconds = result.seconds ? ` (cleared in ${result.seconds}s)` : '';
        showToast(field.label + ' copied' + seconds);
    } else {
        showToast('Clipboard is not available');
    }
}

function install() {
    entryHandler = (entry) => {
        currentEntry = entry;
    };
    Events.on('entry-selected', entryHandler);
    filterHandler = (e) => {
        visibleEntries = e && e.entries ? [...e.entries] : [];
    };
    Events.on('filter', filterHandler);

    keyHandler = (e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey) {
            return;
        }
        if (isEditable(e.target)) {
            return;
        }
        if (e.shiftKey) {
            return;
        }
        const field = FIELDS[e.key];
        if (field) {
            copyField(field);
            e.preventDefault();
            e.stopPropagation();
        }
    };
    document.addEventListener('keydown', keyHandler, true);
}

function uninstall() {
    if (keyHandler) {
        document.removeEventListener('keydown', keyHandler, true);
        keyHandler = null;
    }
    if (entryHandler) {
        Events.off('entry-selected', entryHandler);
        entryHandler = null;
    }
    if (filterHandler) {
        Events.off('filter', filterHandler);
        filterHandler = null;
    }
    if (toastEl && toastEl.parentNode) {
        toastEl.parentNode.removeChild(toastEl);
    }
    toastEl = null;
    clearTimeout(toastTimer);
    currentEntry = null;
    visibleEntries = [];
}

install();

module.exports = { uninstall };
