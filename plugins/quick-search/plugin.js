/**
 * KeeWeb plugin: quick-search
 *
 * Keeps a keyboard-first workflow: Ctrl+K (or Ctrl+F outside an input) jumps to
 * the entry search field, Escape there restores the app's own behaviour.
 *
 * @author Rossw
 * @license MIT
 */

function isEditable(el) {
    if (!el) {
        return false;
    }
    const tag = el.tagName;
    return (
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
    );
}

let keyHandler = null;

function focusSearch() {
    const input = document.querySelector('.list__search-field');
    if (!input) {
        return false;
    }
    input.focus();
    input.select();
    return true;
}

function install() {
    keyHandler = (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) {
            return;
        }
        const key = (e.key || '').toLowerCase();
        if (key !== 'k' && key !== 'f') {
            return;
        }
        // inside a form field only the browser's own find should win
        if (isEditable(e.target) && e.target.className.indexOf('list__search-field') < 0) {
            return;
        }
        if (focusSearch()) {
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
}

install();

module.exports = { uninstall };
