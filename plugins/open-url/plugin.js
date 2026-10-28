/**
 * KeeWeb plugin: open-url
 *
 * Alt+Shift+U sends the selected entry's URL to the system browser, which is
 * how KeePass URL plugins behave. The shell uses its own opener; a browser
 * build falls back to a new tab.
 *
 * @author Rossw
 * @license MIT
 */

const { Events } = require('framework/events');
const { Launcher } = require('comp/launcher');

let currentEntry = null;
let visibleEntries = [];
let keyHandler = null;
let entryHandler = null;
let filterHandler = null;

function selectedEntry() {
    return currentEntry || visibleEntries[0];
}

function openUrl(rawUrl) {
    if (!rawUrl) {
        return false;
    }
    const href = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
    if (Launcher && Launcher.openLink) {
        Launcher.openLink(href);
    } else {
        window.open(href, '_blank', 'noopener,noreferrer');
    }
    return true;
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
        if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) {
            return;
        }
        if ((e.key || '').toLowerCase() !== 'u') {
            return;
        }
        const entry = selectedEntry();
        if (entry && openUrl(entry.url)) {
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
    currentEntry = null;
    visibleEntries = [];
}

install();

module.exports = { uninstall };
