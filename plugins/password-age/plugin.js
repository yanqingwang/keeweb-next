/**
 * KeeWeb plugin: password-age
 *
 * KeePass users track password age with plugins such as Password Age; this one
 * marks list rows after a year and after two years so old secrets stand out
 * without opening every entry.
 *
 * The mark is a left edge in the list plus a tooltip with the exact date; the
 * entry itself is not modified.
 *
 * @author Rossw
 * @license MIT
 */

const { Events } = require('framework/events');

const WARN_DAYS = 365;
const ERROR_DAYS = 730;
const DAY = 24 * 60 * 60 * 1000;

let observer = null;
let refreshTimer = null;
let entriesById = new Map();
let filterHandler = null;
let entryHandler = null;
let currentEntry = null;

function ageInDays(entry) {
    const changed = entry && entry.updated ? new Date(entry.updated).getTime() : 0;
    if (!changed) {
        return 0;
    }
    return Math.floor((Date.now() - changed) / DAY);
}

function markItem(item) {
    const id = item.id;
    if (!id || id.indexOf('footer') === 0) {
        return;
    }
    const entry = entriesById.get(id);
    if (!entry) {
        return;
    }
    const days = ageInDays(entry);
    if (days >= ERROR_DAYS) {
        item.setAttribute('data-pw-age', 'critical');
        item.title = `Password changed ${days} days ago`;
    } else if (days >= WARN_DAYS) {
        item.setAttribute('data-pw-age', 'warning');
        item.title = `Password changed ${days} days ago`;
    } else {
        item.removeAttribute('data-pw-age');
        item.removeAttribute('title');
    }
}

function entriesFromFile(entry) {
    const list = [];
    const file = entry && entry.file;
    if (file && file.forEachEntry) {
        file.forEachEntry({ includeDisabled: true }, (item) => list.push(item));
    }
    return list;
}

function indexEntries(entries) {
    entriesById = new Map();
    for (const entry of entries) {
        entriesById.set(entry.id, entry);
    }
}

function refresh() {
    if (!entriesById.size && currentEntry) {
        indexEntries(entriesFromFile(currentEntry));
    }
    document.querySelectorAll('.list__item[id]').forEach(markItem);
}

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 80);
}

function onMutations() {
    scheduleRefresh();
}

function install() {
    filterHandler = (e) => {
        indexEntries(e && e.entries ? [...e.entries] : []);
        scheduleRefresh();
    };
    Events.on('filter', filterHandler);
    entryHandler = (entry) => {
        currentEntry = entry;
        if (!entriesById.size) {
            indexEntries(entriesFromFile(entry));
        }
        scheduleRefresh();
    };
    Events.on('entry-selected', entryHandler);
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleRefresh();
}

function uninstall() {
    if (filterHandler) {
        Events.off('filter', filterHandler);
        filterHandler = null;
    }
    if (entryHandler) {
        Events.off('entry-selected', entryHandler);
        entryHandler = null;
    }
    entriesById = new Map();
    currentEntry = null;
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    clearTimeout(refreshTimer);
    document.querySelectorAll('.list__item[data-pw-age]').forEach((item) => {
        item.removeAttribute('data-pw-age');
        item.removeAttribute('title');
    });
}

install();

module.exports = { uninstall };
