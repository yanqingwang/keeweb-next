/**
 * KeeWeb plugin: duplicate-finder
 *
 * The KeePass plugin of the same name reports entries sharing a secret; here
 * Ctrl+Alt+D inspects the entries of the current view and reports groups that
 * reuse a password or a URL. Titles are shown, secret values are not.
 *
 * @author Rossw
 * @license MIT
 */

const { Events } = require('framework/events');
const { Alerts } = require('comp/ui/alerts');

let keyHandler = null;
let filterHandler = null;
let entryHandler = null;
let visibleEntries = [];
let currentEntry = null;

function passwordOf(entry) {
    try {
        return entry.password ? entry.password.getText() : '';
    } catch (e) {
        return '';
    }
}

function urlKey(url) {
    if (!url) {
        return '';
    }
    try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        const path = parsed.pathname.replace(/\/+$/, '');
        return host ? host + path : '';
    } catch (e) {
        return url.trim().toLowerCase();
    }
}

function groupBy(entries, keyFn) {
    const groups = new Map();
    for (const entry of entries) {
        const key = keyFn(entry);
        if (!key) {
            continue;
        }
        const list = groups.get(key);
        if (list) {
            list.push(entry);
        } else {
            groups.set(key, [entry]);
        }
    }
    return [...groups.values()].filter((list) => list.length > 1);
}

function describe(groups, limit) {
    const lines = [];
    groups.slice(0, limit).forEach((group) => {
        lines.push(group.map((entry) => entry.title || '(no title)').join(', '));
    });
    if (groups.length > limit) {
        lines.push(`... and ${groups.length - limit} more groups`);
    }
    return lines.join('\n');
}

function entriesFromFile(entry) {
    const list = [];
    const file = entry && entry.file;
    if (file && file.forEachEntry) {
        file.forEachEntry({ includeDisabled: true }, (item) => list.push(item));
    }
    return list;
}

function report() {
    let entries = visibleEntries;
    if (!entries.length && currentEntry) {
        entries = entriesFromFile(currentEntry);
    }
    if (!entries.length) {
        Alerts.info({
            header: 'Duplicate entries',
            body: 'There are no entries in the current view.'
        });
        return;
    }
    const sharedPasswords = groupBy(entries, passwordOf);
    const sharedUrls = groupBy(entries, (entry) => urlKey(entry.url));
    if (!sharedPasswords.length && !sharedUrls.length) {
        Alerts.info({
            header: 'Duplicate entries',
            body: `Checked ${entries.length} entries: no shared passwords or URLs.`
        });
        return;
    }
    const parts = [];
    if (sharedPasswords.length) {
        const count = sharedPasswords.reduce((sum, group) => sum + group.length, 0);
        parts.push(
            `${sharedPasswords.length} password${sharedPasswords.length === 1 ? '' : 's'} ` +
                `shared by ${count} entries:\n${describe(sharedPasswords, 10)}`
        );
    }
    if (sharedUrls.length) {
        const count = sharedUrls.reduce((sum, group) => sum + group.length, 0);
        parts.push(
            `${sharedUrls.length} URL${sharedUrls.length === 1 ? '' : 's'} ` +
                `used by ${count} entries:\n${describe(sharedUrls, 10)}`
        );
    }
    Alerts.alert({
        header: 'Duplicate entries',
        icon: 'copy',
        body: `Checked ${entries.length} entries.\n\n${parts.join('\n\n')}`,
        buttons: [{ result: 'yes', title: 'OK' }]
    });
}

function install() {
    filterHandler = (e) => {
        visibleEntries = e && e.entries ? [...e.entries] : [];
    };
    Events.on('filter', filterHandler);
    entryHandler = (entry) => {
        currentEntry = entry;
    };
    Events.on('entry-selected', entryHandler);
    keyHandler = (e) => {
        if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) {
            return;
        }
        if ((e.key || '').toLowerCase() !== 'd') {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        report();
    };
    document.addEventListener('keydown', keyHandler, true);
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
    visibleEntries = [];
    currentEntry = null;
    if (keyHandler) {
        document.removeEventListener('keydown', keyHandler, true);
        keyHandler = null;
    }
}

install();

module.exports = { uninstall };
