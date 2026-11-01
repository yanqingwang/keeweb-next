import * as kdbxweb from 'kdbxweb';
import { Events } from 'framework/events';
import { Launcher } from 'comp/launcher';
import { box as tweetnaclBox } from 'tweetnacl';
import { PasswordGenerator } from 'util/generators/password-generator';
import { GeneratorPresets } from 'comp/app/generator-presets';
import { Alerts } from 'comp/ui/alerts';
import { Locale } from 'util/locale';
import { RuntimeInfo } from 'const/runtime-info';
import { KnownAppVersions } from 'const/known-app-versions';
import { ExtensionConnectView } from 'views/extension/extension-connect-view';
import { ExtensionCreateGroupView } from 'views/extension/extension-create-group-view';
import { ExtensionSaveEntryView } from 'views/extension/extension-save-entry-view';
import { RuntimeDataModel } from 'models/runtime-data-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { Timeouts } from 'const/timeouts';
import { SelectEntryView } from 'views/select/select-entry-view';
import { SelectEntryFieldView } from 'views/select/select-entry-field-view';
import { SelectEntryFilter } from 'comp/app/select-entry-filter';
import { SearchResultCollection } from 'collections/search-result-collection';
import {
    Field as PasskeyField,
    assertCredential,
    checkChallenge,
    checkUserId,
    effectiveDomainOf,
    hasPasskeyField,
    isOriginAllowed,
    isPasskeyFieldName,
    normalizeOrigin,
    registerCredential,
    validateRpId
} from 'comp/extension/passkeys';

const KeeWebAssociationId = 'KeeWeb';
const KeeWebHash = '398d9c782ec76ae9e9877c2321cbda2b31fc6d18ccf0fed5ca4bd746bab4d64a'; // sha256('KeeWeb')
const ExtensionGroupIconId = 1;
const DefaultExtensionGroupName = 'Browser';
const ExtensionGroupNames = new Set(['KeePassXC-Browser Passwords', DefaultExtensionGroupName]);
// a page with more matches than this needs the extension's own search anyway
const KeePassXcEntryLimit = 30;

// Actions whose payload is credential material: never echoed to the console
const PasskeyActions = new Set(['passkeys-register', 'passkeys-get']);

const Errors = {
    noOpenFiles: {
        message: Locale.extensionErrorNoOpenFiles,
        code: '1'
    },
    userRejected: {
        message: Locale.extensionErrorUserRejected,
        code: '6'
    },
    // passkey codes are the ones KeePassXC-Browser expects, so the extension
    // can tell "nothing saved" from "the user said no"
    passkeyNoCredentials: {
        message: Locale.extensionPasskeyNoCredentials,
        code: '15'
    },
    passkeyExcluded: {
        message: Locale.extensionPasskeyExcluded,
        code: '21'
    },
    passkeyOriginNotAllowed: {
        message: Locale.extensionPasskeyOriginNotAllowed,
        code: '26'
    },
    passkeyDomainMismatch: {
        message: Locale.extensionPasskeyDomainMismatch,
        code: '28'
    },
    passkeyUnknown: {
        message: Locale.extensionPasskeyUnknownError,
        code: '31'
    },
    passkeyUserVerificationRequired: {
        message: Locale.extensionPasskeyUserVerificationRequired,
        code: '31'
    }
};

const connectedClients = new Map();

let logger;
let appModel;
let sendEvent;

function setupListeners() {
    Events.on('file-opened', () => {
        sendEvent({ action: 'database-unlocked' });
    });
    Events.on('one-file-closed', () => {
        if (!appModel.files.hasOpenFiles()) {
            sendEvent({ action: 'database-locked' });
        }
    });
    Events.on('all-files-closed', () => {
        sendEvent({ action: 'database-locked' });
    });
}

function incrementNonce(nonce) {
    // from libsodium/utils.c, like it is in KeePassXC
    let i = 0;
    let c = 1;
    for (; i < nonce.length; ++i) {
        c += nonce[i];
        nonce[i] = c;
        c >>= 8;
    }
}

function getClient(request) {
    if (!request.clientID) {
        throw new Error('Empty clientID');
    }
    const client = connectedClients.get(request.clientID);
    if (!client) {
        throw new Error(`Client not connected: ${request.clientID}`);
    }
    return client;
}

function decryptRequest(request) {
    const client = getClient(request);

    if (!request.nonce) {
        throw new Error('Empty nonce');
    }
    if (!request.message) {
        throw new Error('Empty message');
    }

    const nonce = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
    const message = kdbxweb.ByteUtils.base64ToBytes(request.message);

    const data = tweetnaclBox.open(message, nonce, client.publicKey, client.keys.secretKey);
    if (!data) {
        throw new Error('Failed to decrypt data');
    }

    const json = new TextDecoder().decode(data);
    const payload = JSON.parse(json);

    // credential ids, challenges and user handles are the lookup keys for a
    // passkey; they do not belong in a developer console
    if (payload && !PasskeyActions.has(payload.action)) {
        logger.debug('Extension -> KeeWeb -> (decrypted)', payload);
    }

    if (!payload) {
        throw new Error('Empty request payload');
    }
    if (payload.action !== request.action) {
        throw new Error(`Bad action in decrypted payload`);
    }

    return payload;
}

function encryptResponse(request, payload) {
    if (!PasskeyActions.has(request.action)) {
        logger.debug('KeeWeb -> Extension (decrypted)', payload);
    }

    const nonceBytes = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
    incrementNonce(nonceBytes);
    const nonce = kdbxweb.ByteUtils.bytesToBase64(nonceBytes);

    const client = getClient(request);

    payload.nonce = nonce;

    const json = JSON.stringify(payload);
    const data = new TextEncoder().encode(json);

    const encrypted = tweetnaclBox(data, nonceBytes, client.publicKey, client.keys.secretKey);

    const message = kdbxweb.ByteUtils.bytesToBase64(encrypted);

    return {
        action: request.action,
        message,
        nonce
    };
}

function makeError(def) {
    const e = new Error(def.message);
    e.code = def.code;
    return e;
}

function ensureAtLeastOneFileIsOpen() {
    if (!appModel.files.hasOpenFiles()) {
        throw makeError(Errors.noOpenFiles);
    }
}

async function checkContentRequestPermissions(request) {
    if (!appModel.files.hasOpenFiles()) {
        if (AppSettingsModel.extensionFocusIfLocked) {
            try {
                focusKeeWeb();
                await appModel.unlockAnyFile(
                    'extensionUnlockMessage',
                    Timeouts.KeeWebConnectRequest
                );
            } catch {
                throw makeError(Errors.noOpenFiles);
            }
        } else {
            throw makeError(Errors.noOpenFiles);
        }
    }

    const client = getClient(request);
    if (client.permissions) {
        return;
    }

    if (Alerts.alertDisplayed) {
        throw new Error(Locale.extensionErrorAlertDisplayed);
    }

    focusKeeWeb();

    // a decision the user asked to remember skips this dialog for good; it is
    // the only way the extension can read credentials without a confirmation
    // every time the app restarts, because permissions live in memory only
    const remembered = AppSettingsModel.extensionConnectRemembered;
    if (remembered) {
        client.permissions = {
            allFiles: true,
            files: [],
            askGet: remembered.askGet || 'multiple'
        };
        return;
    }

    const config = RuntimeDataModel.extensionConnectConfig;
    const files = appModel.files.map((f) => ({
        id: f.id,
        name: f.name,
        checked: !config || config.allFiles || config.files.includes(f.id)
    }));
    if (!files.some((f) => f.checked)) {
        for (const f of files) {
            f.checked = true;
        }
    }

    const extensionConnectView = new ExtensionConnectView({
        extensionName: getHumanReadableExtensionName(client),
        identityVerified: !Launcher,
        files,
        allFiles: config?.allFiles ?? true,
        askGet: config?.askGet || 'multiple'
    });

    try {
        await alertWithTimeout({
            header: Locale.extensionConnectHeader,
            icon: 'exchange-alt',
            buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
            view: extensionConnectView,
            wide: true,
            opaque: true
        });
    } catch (e) {
        client.permissionsDenied = true;
        Events.emit('browser-extension-sessions-changed');
        throw e;
    }

    RuntimeDataModel.extensionConnectConfig = extensionConnectView.config;
    client.permissions = extensionConnectView.config;
    if (extensionConnectView.config.remember) {
        AppSettingsModel.extensionConnectRemembered = {
            askGet: extensionConnectView.config.askGet
        };
    }
    Events.emit('browser-extension-sessions-changed');
}

function alertWithTimeout(config) {
    return new Promise((resolve, reject) => {
        let inactivityTimer = 0;

        const alert = Alerts.alert({
            ...config,
            enter: 'yes',
            esc: '',
            success: (res) => {
                clearTimeout(inactivityTimer);
                resolve(res);
            },
            cancel: () => {
                clearTimeout(inactivityTimer);
                reject(makeError(Errors.userRejected));
            }
        });

        inactivityTimer = setTimeout(() => {
            alert.closeWithResult('');
        }, Timeouts.KeeWebConnectRequest);
    });
}

// Passkey failures must travel encrypted like any other payload: the
// extension treats an unencrypted error as "no answer" and reports every
// failure as a cancelled request, so the page could not tell "nothing saved"
// from "the user said no".
async function passkeyResponse(request, run) {
    let response;
    let error;
    try {
        response = await run();
    } catch (e) {
        if (!e.code) {
            logger.error(`Error in passkey handler ${request.action}`, e);
        }
        error = { errorCode: +(e.code || Errors.passkeyUnknown.code) };
    }
    return encryptResponse(request, {
        success: 'true',
        version: getVersion(request),
        ...(error ? { response: error } : { response })
    });
}

function getAvailableFiles(request) {
    const client = getClient(request);
    if (!client.permissions) {
        return;
    }

    const files = appModel.files.filter(
        (file) =>
            file.active &&
            (client.permissions.allFiles || client.permissions.files.includes(file.id))
    );
    if (!files.length) {
        throw makeError(Errors.noOpenFiles);
    }

    return files;
}

function getVersion(request) {
    return isKeePassXcBrowser(request) ? KnownAppVersions.KeePassXC : RuntimeInfo.version;
}

function fieldText(entry, field) {
    const value = entry.getFieldValue(field);
    if (!value) {
        return '';
    }
    return value.isProtected ? value.getText() : value + '';
}

// Same, but never decrypts: used to test whether a field is present without
// pulling every stored private key into memory.
function hasFieldText(entry, field) {
    const value = entry.getFieldValue(field);
    if (!value) {
        return false;
    }
    return value.isProtected ? value.byteLength > 0 : !!value;
}

function findEntryByUuid(files, uuidHex) {
    const id = kdbxweb.ByteUtils.bytesToBase64(kdbxweb.ByteUtils.hexToBytes(uuidHex));
    for (const file of files) {
        const entry = file.getEntry(file.subId(id));
        if (entry) {
            return entry;
        }
    }
    return undefined;
}

function isPasskeyEntry(entry) {
    // any KPEX_PASSKEY_* field, in any capitalisation: the same entry must be
    // treated the same way by every channel
    return hasPasskeyField(entry);
}

// Entries in the recycle bin are deleted as far as the user is concerned: a
// deleted passkey must not keep signing. The recycle bin is a normal group, so
// walking the parent chain is what tells "deleted" from "still in use".
function isInTrash(file, entry) {
    return groupIsInTrash(file, entry.group);
}

// Only an explicit "no recycle bin" disables the check. kdbxweb leaves
// recycleBinEnabled undefined when the node is absent, and a bin that exists
// without that flag still holds deleted entries.
function groupIsInTrash(file, group) {
    const trashUuid = file.db.meta.recycleBinUuid;
    if (file.db.meta.recycleBinEnabled === false || !trashUuid) {
        return false;
    }
    const trashId = file.subId(trashUuid.id);
    for (let node = group; node; node = node.parentGroup) {
        if (node.id === trashId) {
            return true;
        }
    }
    return false;
}

// Passkeys live in their own entries: the relying party and the private key
// are per-credential, and mixing them into a password entry makes both harder
// to read.
//
// Entries are walked with the normal search filter, not includeDisabled: a
// passkey the user disabled must not keep signing. That filter already skips
// the entry-templates group; the recycle bin is excluded below.
function findPasskeyEntries(files, rpId, allowedIds) {
    const wanted = new Set(allowedIds || []);
    const matches = [];
    for (const file of files) {
        file.forEachEntry({}, (entry) => {
            if (isInTrash(file, entry)) {
                return;
            }
            if (fieldText(entry, PasskeyField.RELYING_PARTY) !== rpId) {
                return;
            }
            const credentialId =
                fieldText(entry, PasskeyField.GENERATED_USER_ID) ||
                fieldText(entry, PasskeyField.CREDENTIAL_ID);
            if (!credentialId || !hasFieldText(entry, PasskeyField.PRIVATE_KEY_PEM)) {
                return;
            }
            // an empty allowCredentials list means any credential for this RP
            if (wanted.size && !wanted.has(credentialId)) {
                return;
            }
            matches.push(entry);
        });
    }
    return matches;
}

function findPasskeyEntry(files, rpId, credentialId) {
    if (!credentialId) {
        return undefined;
    }
    return findPasskeyEntries(files, rpId, [credentialId])[0];
}

// Signing is an action the user should see: the picker shows up when there is
// a choice to make, and a plain confirmation when there is not. That is also
// what makes the UV flag honest — the assertion is only produced after the
// user answered a prompt.
async function pickPasskeyEntry(entries, origin, client) {
    // One signing prompt at a time: a page can fire several get() calls at
    // once, and stacked dialogs with the same text make one click approve an
    // unknown number of signatures.
    if (Alerts.alertDisplayed) {
        throw makeError(Errors.userRejected);
    }
    if (entries.length === 1) {
        await alertWithTimeout({
            header: Locale.extensionPasskeyGetHeader,
            body: Locale.extensionPasskeyGetBody
                .replace('{}', getHumanReadableExtensionName(client))
                .replace('{}', origin),
            icon: 'key',
            buttons: [Alerts.buttons.allow, Alerts.buttons.deny]
        });
        return entries[0];
    }
    const filter = new SelectEntryFilter(
        { url: origin, excludePasskeys: false },
        appModel,
        undefined,
        undefined
    );
    // the candidate list is already resolved; the view still needs a
    // collection and its own text filtering has to keep working
    filter.getEntries = function () {
        const text = (this.text || '').toLowerCase();
        const matched = text
            ? entries.filter((entry) => (entry.title || '').toLowerCase().includes(text))
            : entries;
        return new SearchResultCollection(matched, { comparator: 'none' });
    };
    const selectEntryView = new SelectEntryView({
        filter,
        topMessage: Locale.extensionPasskeyGetBody
            .replace('{}', getHumanReadableExtensionName(client))
            .replace('{}', origin)
    });
    focusKeeWeb();
    const inactivityTimer = setTimeout(() => {
        selectEntryView.emit('result', undefined);
    }, Timeouts.KeeWebConnectRequest);
    const result = await selectEntryView.showAndGetResult();
    clearTimeout(inactivityTimer);
    if (!result || !result.entry) {
        throw makeError(Errors.userRejected);
    }
    return result.entry;
}

function getPasskeyGroup(files) {
    const file = files[0];
    let group;
    file.forEachGroup((candidate) => {
        // the recycle bin is a normal group: a trashed "Browser" group must not
        // collect new passkeys that findPasskeyEntries() then refuses to use
        if (
            !group &&
            candidate.title === DefaultExtensionGroupName &&
            !isInTrash(file, candidate)
        ) {
            group = candidate;
        }
    });
    if (group) {
        return group;
    }
    group = appModel.createNewGroupWithName(file.groups[0], file, DefaultExtensionGroupName);
    group.setIcon(ExtensionGroupIconId);
    return group;
}

function isKeeWebConnect(request) {
    return getClient(request).connection.extensionName === 'KeeWeb Connect';
}

function isKeePassXcBrowser(request) {
    return getClient(request).connection.extensionName === 'KeePassXC-Browser';
}

function getHumanReadableExtensionName(client) {
    return client.connection.appName
        ? `${client.connection.extensionName} (${client.connection.appName})`
        : client.connection.extensionName;
}

function focusKeeWeb() {
    logger.debug('Focus KeeWeb');
    if (Launcher) {
        if (!Launcher.isAppFocused()) {
            Launcher.showMainWindow();
        }
    } else {
        sendEvent({ action: 'attention-required' });
    }
}

function entryToResponseEntry(entry) {
    return {
        group: entry.group.title,
        login: entry.user || '',
        name: entry.title || '',
        password: entry.password?.getText() || '',
        skipAutoSubmit: 'false',
        stringFields: [],
        uuid: kdbxweb.ByteUtils.bytesToHex(entry.entry.uuid.bytes)
    };
}

// same matching findEntry uses, minus the single-entry shortcut and the
// in-app picker: picking belongs to the extension's own popup
async function matchingEntries(request) {
    const payload = decryptRequest(request);
    await checkContentRequestPermissions(request);

    if (!payload.url) {
        throw new Error('Empty url');
    }

    const filter = new SelectEntryFilter(
        { url: payload.url, title: payload.title },
        appModel,
        getAvailableFiles(request),
        undefined
    );
    filter.subdomains = false;
    let entries = filter.getEntries();
    if (!entries.length) {
        filter.subdomains = true;
        entries = filter.getEntries();
    }
    if (!entries.length) {
        throw makeError(Errors.noMatches);
    }

    return {
        count: Math.min(entries.length, KeePassXcEntryLimit),
        entries: entries.slice(0, KeePassXcEntryLimit).map(entryToResponseEntry)
    };
}

async function findEntry(request, returnIfOneMatch, filterOptions) {
    const payload = decryptRequest(request);
    await checkContentRequestPermissions(request);

    if (!payload.url) {
        throw new Error('Empty url');
    }

    const files = getAvailableFiles(request);
    const client = getClient(request);

    const filter = new SelectEntryFilter(
        { url: payload.url, title: payload.title },
        appModel,
        files,
        filterOptions
    );
    filter.subdomains = false;

    let entries = filter.getEntries();

    filter.subdomains = true;

    let entry;

    if (entries.length) {
        if (entries.length === 1 && returnIfOneMatch && client.permissions.askGet === 'multiple') {
            entry = entries[0];
        }
    } else {
        entries = filter.getEntries();

        if (!entries.length) {
            if (AppSettingsModel.extensionFocusIfEmpty) {
                filter.useUrl = false;
                if (filter.title && AppSettingsModel.autoTypeTitleFilterEnabled) {
                    filter.useTitle = true;
                    entries = filter.getEntries();
                    if (!entries.length) {
                        filter.useTitle = false;
                    }
                }
            } else {
                throw makeError(Errors.noMatches);
            }
        }
    }

    if (!entry) {
        const extName = getHumanReadableExtensionName(client);
        const topMessage = Locale.extensionSelectPasswordFor.replace('{}', extName);
        // the filter already keeps passkey entries out, and the view calls
        // filter.getEntries() again on its own, so it stays consistent
        const selectEntryView = new SelectEntryView({ filter, topMessage });

        focusKeeWeb();

        const inactivityTimer = setTimeout(() => {
            selectEntryView.emit('result', undefined);
        }, Timeouts.KeeWebConnectRequest);

        const result = await selectEntryView.showAndGetResult();

        clearTimeout(inactivityTimer);

        entry = result?.entry;
        if (!entry) {
            throw makeError(Errors.userRejected);
        }
    }

    client.stats.passwordsRead++;

    return entry;
}

const ProtocolHandlers = {
    'ping'({ data }) {
        return { data };
    },

    'change-public-keys'(request, connection) {
        let { publicKey, version, clientID: clientId } = request;

        if (connectedClients.has(clientId)) {
            throw new Error('Changing keys is not allowed');
        }

        if (!Launcher) {
            // on web there can be only one connected client
            connectedClients.clear();
        }

        const keys = tweetnaclBox.keyPair();
        publicKey = kdbxweb.ByteUtils.base64ToBytes(publicKey);

        const stats = {
            connectedDate: new Date(),
            passwordsRead: 0,
            passwordsWritten: 0
        };

        connectedClients.set(clientId, { connection, publicKey, version, keys, stats });

        Events.emit('browser-extension-sessions-changed');

        logger.info('New client key created', clientId, version);

        const nonceBytes = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
        incrementNonce(nonceBytes);
        const nonce = kdbxweb.ByteUtils.bytesToBase64(nonceBytes);

        return {
            action: 'change-public-keys',
            version: getVersion(request),
            publicKey: kdbxweb.ByteUtils.bytesToBase64(keys.publicKey),
            nonce,
            success: 'true',
            ...(isKeeWebConnect(request) ? { appName: 'KeeWeb' } : undefined)
        };
    },

    async 'get-databasehash'(request) {
        decryptRequest(request);

        if (request.triggerUnlock) {
            await checkContentRequestPermissions(request);
        }
        // No open vault is not an error here. The hash identifies this app, not
        // the database, and KeePassXC answers in the same state too. Failing
        // with an error code makes the extension set `isDatabaseClosed`, which
        // aborts association before it is even attempted — the extension then
        // reports that the app is not connected, which is what a user sees on
        // first run. Actions that read or write entries still require a vault.

        return encryptResponse(request, {
            hash: KeeWebHash,
            success: 'true',
            version: getVersion(request)
        });
    },

    'generate-password'(request) {
        const password = PasswordGenerator.generate(GeneratorPresets.browserExtensionPreset);

        return encryptResponse(request, {
            version: getVersion(request),
            success: 'true',
            entries: [{ password }]
        });
    },

    'lock-database'(request) {
        decryptRequest(request);
        ensureAtLeastOneFileIsOpen();

        Events.emit('lock-workspace');

        if (Alerts.alertDisplayed) {
            focusKeeWeb();
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request)
        });
    },

    'associate'(request) {
        decryptRequest(request);
        // Association needs no vault: both the association id and the hash are
        // constants, and the extension calls this right after the handshake.
        // Refusing here leaves the extension permanently unassociated and the
        // user without any way to connect.

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            id: KeeWebAssociationId
        });
    },

    'test-associate'(request) {
        const payload = decryptRequest(request);
        // ensureAtLeastOneFileIsOpen();

        if (payload.id !== KeeWebAssociationId) {
            throw makeError(Errors.noOpenFiles);
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            id: payload.id
        });
    },

    async 'get-logins'(request) {
        if (isKeePassXcBrowser(request)) {
            // KeePassXC answers with every match: the extension compares the
            // credentials a page submits against this list to decide whether
            // they are already known. Answering with a single best entry made
            // it offer to save a password it had just handed out.
            const { count, entries } = await matchingEntries(request);
            return encryptResponse(request, {
                success: 'true',
                version: getVersion(request),
                hash: KeeWebHash,
                count,
                entries,
                id: ''
            });
        }

        const entry = await findEntry(request, true);

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            count: 1,
            entries: [entryToResponseEntry(entry)],
            id: ''
        });
    },

    async 'get-totp-by-url'(request) {
        const entry = await findEntry(request, true, { otp: true });

        entry.initOtpGenerator();

        if (!entry.otpGenerator) {
            throw makeError(Errors.noMatches);
        }

        let selectEntryFieldView;
        if (entry.needsTouch) {
            selectEntryFieldView = new SelectEntryFieldView({
                needsTouch: true,
                deviceShortName: entry.device.shortName
            });
            selectEntryFieldView.render();
        }

        const otpPromise = new Promise((resolve, reject) => {
            selectEntryFieldView?.on('result', () => reject(makeError(Errors.userRejected)));
            entry.otpGenerator.next((err, otp) => {
                if (otp) {
                    resolve(otp);
                } else {
                    reject(err || makeError(Errors.userRejected));
                }
            });
        });

        let totp;
        try {
            totp = await otpPromise;
        } finally {
            selectEntryFieldView?.remove();
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            totp
        });
    },

    async 'get-any-field'(request) {
        const entry = await findEntry(request, false);

        const selectEntryFieldView = new SelectEntryFieldView({
            entry
        });
        const inactivityTimer = setTimeout(() => {
            selectEntryFieldView.emit('result', undefined);
        }, Timeouts.KeeWebConnectRequest);

        const field = await selectEntryFieldView.showAndGetResult();

        clearTimeout(inactivityTimer);

        if (!field) {
            throw makeError(Errors.userRejected);
        }

        // The picker already hides these, but the field name arrives from the
        // extension: never hand out passkey credential material here.
        if (isPasskeyFieldName(field)) {
            throw makeError(Errors.userRejected);
        }

        let value = entry.getAllFields()[field];
        if (value.isProtected) {
            value = value.getText();
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            field,
            value
        });
    },

    async 'get-totp'(request) {
        const payload = decryptRequest(request);
        await checkContentRequestPermissions(request);

        if (!payload.uuid) {
            throw makeError(Errors.noMatches);
        }
        const files = getAvailableFiles(request);
        const entry = findEntryByUuid(files, payload.uuid);
        // a passkey entry is not a TOTP carrier: its fields must not be
        // reachable through this action either
        if (!entry || isPasskeyEntry(entry)) {
            throw makeError(Errors.noMatches);
        }
        entry.initOtpGenerator();
        if (!entry.otpGenerator) {
            throw makeError(Errors.noMatches);
        }
        const totp = await new Promise((resolve, reject) => {
            entry.otpGenerator.next((err, code) =>
                code ? resolve(code) : reject(err || makeError(Errors.noMatches))
            );
        });
        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            totp
        });
    },

    async 'passkeys-register'(request) {
        const payload = decryptRequest(request);
        await checkContentRequestPermissions(request);

        return passkeyResponse(request, async () => {
            const options = payload.publicKey;
            const origin = normalizeOrigin(payload.origin);
            if (!options || typeof options !== 'object') {
                throw makeError(Errors.passkeyUnknown);
            }
            if (!isOriginAllowed(origin, AppSettingsModel.extensionPasskeysAllowLocalhost)) {
                throw makeError(Errors.passkeyOriginNotAllowed);
            }
            if (
                !checkChallenge(options.challenge) ||
                !options.user ||
                !checkUserId(options.user.id)
            ) {
                throw makeError(Errors.passkeyUnknown);
            }
            // UV is never set on our assertions, so a site asking for it would
            // fail verification anyway: say so instead of pretending
            if (options.authenticatorSelection?.userVerification === 'required') {
                throw makeError(Errors.passkeyUserVerificationRequired);
            }
            const effectiveDomain = effectiveDomainOf(origin);
            const rpId = validateRpId(
                options.rp && options.rp.id,
                effectiveDomain,
                AppSettingsModel.extensionPasskeysAllowLocalhost
            );
            if (!rpId) {
                throw makeError(Errors.passkeyDomainMismatch);
            }

            const files = getAvailableFiles(request);
            const client = getClient(request);

            // excludeCredentials is the site's own "already registered" list: an
            // existing credential there means the site wants an update, not a
            // duplicate entry
            const excluded = options.excludeCredentials || [];
            for (const descriptor of excluded) {
                const existing = findPasskeyEntry(files, rpId, descriptor && descriptor.id);
                if (existing) {
                    throw makeError(Errors.passkeyExcluded);
                }
            }

            // page-supplied and unbounded, so the entry field gets a sane cap
            const username = (options.user.name || options.user.displayName || rpId)
                .toString()
                .slice(0, 256);

            // The dialog shows the validated rpId and the origin, never the
            // page-supplied rp.name: that string is attacker-controlled and
            // could otherwise claim to be a site the user trusts.
            if (Alerts.alertDisplayed) {
                throw makeError(Errors.userRejected);
            }
            await alertWithTimeout({
                header: Locale.extensionPasskeyRegisterHeader,
                body: Locale.extensionPasskeyRegisterBody
                    .replace('{}', getHumanReadableExtensionName(client))
                    .replace('{}', rpId)
                    .replace('{}', origin),
                icon: 'key',
                buttons: [Alerts.buttons.allow, Alerts.buttons.deny]
            });

            focusKeeWeb();

            const credential = await registerCredential({ options, origin, rpId });

            const group = getPasskeyGroup(files);
            const entryFields = {
                // the title comes from the validated rpId, not from rp.name:
                // a page could otherwise plant a look-alike brand name in the
                // user's Browser group
                Title: rpId + ' (Passkey)',
                UserName: username,
                URL: origin,
                [PasskeyField.RELYING_PARTY]: rpId,
                [PasskeyField.USERNAME]: username,
                [PasskeyField.CREDENTIAL_ID]: kdbxweb.ProtectedValue.fromString(
                    credential.credentialId
                ),
                [PasskeyField.PRIVATE_KEY_PEM]: kdbxweb.ProtectedValue.fromString(
                    credential.privateKeyPem
                ),
                [PasskeyField.USER_HANDLE]: kdbxweb.ProtectedValue.fromString(
                    credential.userHandle
                ),
                [PasskeyField.FLAG_BE]: '1',
                [PasskeyField.FLAG_BS]: '1'
            };
            appModel.createNewEntryWithFields(group, entryFields);

            client.stats.passwordsWritten++;

            Events.emit('browser-extension-sessions-changed');
            Events.emit('refresh');

            return credential.response;
        });
    },

    async 'passkeys-get'(request) {
        const payload = decryptRequest(request);
        await checkContentRequestPermissions(request);

        return passkeyResponse(request, async () => {
            const options = payload.publicKey;
            const origin = normalizeOrigin(payload.origin);
            if (!options || typeof options !== 'object') {
                throw makeError(Errors.passkeyUnknown);
            }
            if (!isOriginAllowed(origin, AppSettingsModel.extensionPasskeysAllowLocalhost)) {
                throw makeError(Errors.passkeyOriginNotAllowed);
            }
            if (!checkChallenge(options.challenge)) {
                throw makeError(Errors.passkeyUnknown);
            }
            if (options.userVerification === 'required') {
                throw makeError(Errors.passkeyUserVerificationRequired);
            }
            const effectiveDomain = effectiveDomainOf(origin);
            const rpId = validateRpId(
                options.rpId,
                effectiveDomain,
                AppSettingsModel.extensionPasskeysAllowLocalhost
            );
            if (!rpId) {
                throw makeError(Errors.passkeyDomainMismatch);
            }

            const files = getAvailableFiles(request);
            const client = getClient(request);

            // allowCredentials is the site's list of acceptable credentials; an
            // empty list means "any passkey for this relying party"
            const allowed = (options.allowCredentials || [])
                .map((descriptor) => descriptor && descriptor.id)
                .filter(Boolean);
            const candidates = findPasskeyEntries(files, rpId, allowed);
            if (!candidates.length) {
                throw makeError(Errors.passkeyNoCredentials);
            }

            const entry = await pickPasskeyEntry(candidates, origin, client);
            // the entry was resolved before the dialog: re-resolve it so a
            // credential deleted, disabled or moved to the recycle bin while
            // the prompt was up cannot still sign
            const credentialId =
                fieldText(entry, PasskeyField.CREDENTIAL_ID) ||
                fieldText(entry, PasskeyField.GENERATED_USER_ID);
            if (!findPasskeyEntry(getAvailableFiles(request), rpId, credentialId)) {
                throw makeError(Errors.userRejected);
            }
            const privateKeyPem = fieldText(entry, PasskeyField.PRIVATE_KEY_PEM);
            const userHandle = fieldText(entry, PasskeyField.USER_HANDLE);
            if (!privateKeyPem || !credentialId) {
                throw makeError(Errors.passkeyUnknown);
            }

            const response = await assertCredential({
                challenge: options.challenge,
                origin,
                rpId,
                credentialId,
                privateKeyPem,
                userHandle,
                // a click on the confirmation is presence, not verification:
                // reporting UV here would be a false claim to the site
                userVerified: false
            });

            client.stats.passwordsRead++;

            return response;
        });
    },

    async 'set-login'(request) {
        const payload = decryptRequest(request);
        await checkContentRequestPermissions(request);

        focusKeeWeb();

        if (!payload.url) {
            throw new Error('Empty url');
        }
        const url = new URL(payload.url);

        const files = getAvailableFiles(request);
        const client = getClient(request);

        let selectedGroup;

        let entryToUpdate;
        if (payload.uuid) {
            for (const file of files) {
                const entryId = kdbxweb.ByteUtils.bytesToBase64(
                    kdbxweb.ByteUtils.hexToBytes(payload.uuid)
                );
                const foundEntry = file.getEntry(file.subId(entryId));
                if (foundEntry) {
                    if (entryToUpdate) {
                        throw new Error('Two entries with the same ID found');
                    } else {
                        entryToUpdate = foundEntry;
                        selectedGroup = foundEntry.group;
                    }
                }
            }
            if (!entryToUpdate) {
                throw new Error('Updated entry not found');
            }
            // a passkey entry is not a password carrier: rewriting it would mix
            // credential material with login fields
            if (isPasskeyEntry(entryToUpdate)) {
                throw makeError(Errors.noMatches);
            }
        }

        if (client.permissions.askSave === 'auto' && client.permissions.saveTo && !selectedGroup) {
            const file = files.find((f) => f.id === client.permissions.saveTo.fileId);
            selectedGroup = file?.getGroup(client.permissions.saveTo.groupId);
        }

        if (client.permissions.askSave !== 'auto' || !selectedGroup) {
            if (!selectedGroup && RuntimeDataModel.extensionSaveConfig) {
                const file = files.find(
                    (f) => f.id === RuntimeDataModel.extensionSaveConfig.fileId
                );
                selectedGroup = file?.getGroup(RuntimeDataModel.extensionSaveConfig.groupId);
            }

            const allGroups = [];
            for (const file of files) {
                file.forEachGroup((group) => {
                    const spaces = [];
                    for (let parent = group; parent.parentGroup; parent = parent.parentGroup) {
                        spaces.push(' ', ' ');
                    }

                    if (
                        !selectedGroup &&
                        group.iconId === ExtensionGroupIconId &&
                        ExtensionGroupNames.has(group.title)
                    ) {
                        selectedGroup = group;
                    }

                    allGroups.push({
                        id: group.id,
                        fileId: file.id,
                        spaces,
                        title: group.title,
                        selected: group.id === selectedGroup?.id
                    });
                });
            }
            if (!selectedGroup) {
                allGroups.splice(1, 0, {
                    id: '',
                    fileId: files[0].id,
                    spaces: [' ', ' '],
                    title: `${DefaultExtensionGroupName} (${Locale.extensionSaveEntryNewGroup})`,
                    selected: true
                });
            }

            const saveEntryView = new ExtensionSaveEntryView({
                extensionName: getHumanReadableExtensionName(client),
                url: payload.url,
                user: payload.login,
                askSave: RuntimeDataModel.extensionSaveConfig?.askSave || 'always',
                update: !!entryToUpdate,
                allGroups
            });

            await alertWithTimeout({
                header: Locale.extensionSaveEntryHeader,
                icon: 'plus',
                buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
                view: saveEntryView
            });

            const config = { ...saveEntryView.config };
            if (!entryToUpdate) {
                if (config.groupId) {
                    const file = files.find((f) => f.id === config.fileId);
                    selectedGroup = file.getGroup(config.groupId);
                } else {
                    selectedGroup = appModel.createNewGroupWithName(
                        files[0].groups[0],
                        files[0],
                        DefaultExtensionGroupName
                    );
                    selectedGroup.setIcon(ExtensionGroupIconId);
                    config.groupId = selectedGroup.id;
                }

                RuntimeDataModel.extensionSaveConfig = config;
                client.permissions.saveTo = { fileId: config.fileId, groupId: config.groupId };
            }

            client.permissions.askSave = config.askSave;
        }

        const entryFields = {
            Title: url.hostname,
            UserName: payload.login,
            Password: kdbxweb.ProtectedValue.fromString(payload.password || ''),
            URL: payload.url
        };

        if (entryToUpdate) {
            for (const [field, value] of Object.entries(entryFields)) {
                if (value) {
                    entryToUpdate.setField(field, value);
                }
            }
        } else {
            appModel.createNewEntryWithFields(selectedGroup, entryFields);
        }

        client.stats.passwordsWritten++;

        Events.emit('browser-extension-sessions-changed');
        Events.emit('refresh');

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            count: null,
            entries: null,
            hash: KeeWebHash
        });
    },

    async 'get-database-groups'(request) {
        decryptRequest(request);
        await checkContentRequestPermissions(request);

        const makeGroups = (group) => {
            const res = {
                name: group.title,
                uuid: kdbxweb.ByteUtils.bytesToHex(group.group.uuid.bytes),
                children: []
            };
            for (const subGroup of group.items) {
                if (subGroup.matches()) {
                    res.children.push(makeGroups(subGroup));
                }
            }
            return res;
        };

        const groups = [];
        for (const file of getAvailableFiles(request)) {
            for (const group of file.groups) {
                groups.push(makeGroups(group));
            }
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            groups: { groups }
        });
    },

    async 'create-new-group'(request) {
        const payload = decryptRequest(request);
        await checkContentRequestPermissions(request);

        if (!payload.groupName) {
            throw new Error('No groupName');
        }

        const groupNames = payload.groupName
            .split('/')
            .map((g) => g.trim())
            .filter((g) => g);

        if (!groupNames.length) {
            throw new Error('Empty group path');
        }

        const files = getAvailableFiles(request);

        for (const file of files) {
            for (const rootGroup of file.groups) {
                let foundGroup = rootGroup;
                const pendingGroups = [...groupNames];
                while (pendingGroups.length && foundGroup) {
                    const title = pendingGroups.shift();
                    foundGroup = foundGroup.items.find((g) => g.title === title);
                }
                if (foundGroup) {
                    return encryptResponse(request, {
                        success: 'true',
                        version: getVersion(request),
                        name: foundGroup.title,
                        uuid: kdbxweb.ByteUtils.bytesToHex(foundGroup.group.uuid.bytes)
                    });
                }
            }
        }

        const client = getClient(request);
        const createGroupView = new ExtensionCreateGroupView({
            extensionName: getHumanReadableExtensionName(client),
            groupPath: groupNames.join(' / '),
            files: files.map((f, ix) => ({ id: f.id, name: f.name, selected: ix === 0 }))
        });

        await alertWithTimeout({
            header: Locale.extensionNewGroupHeader,
            icon: 'folder-plus',
            buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
            view: createGroupView
        });

        const selectedFile = files.find((f) => f.id === createGroupView.selectedFile);

        let newGroup = selectedFile.groups[0];
        const pendingGroups = [...groupNames];

        while (pendingGroups.length) {
            const title = pendingGroups.shift();
            const item = newGroup.items.find((g) => g.title === title);
            if (item) {
                newGroup = item;
            } else {
                newGroup = appModel.createNewGroupWithName(newGroup, selectedFile, title);
            }
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            name: newGroup.title,
            uuid: kdbxweb.ByteUtils.bytesToHex(newGroup.group.uuid.bytes)
        });
    }
};

const ProtocolImpl = {
    init(vars) {
        appModel = vars.appModel;
        logger = vars.logger;
        sendEvent = vars.sendEvent;

        setupListeners();
    },

    cleanup() {
        const wasNotEmpty = connectedClients.size;

        connectedClients.clear();

        if (wasNotEmpty) {
            Events.emit('browser-extension-sessions-changed');
        }
    },

    deleteConnection(connectionId) {
        for (const [clientId, client] of connectedClients.entries()) {
            if (client.connection.connectionId === connectionId) {
                connectedClients.delete(clientId);
            }
        }
        Events.emit('browser-extension-sessions-changed');
    },

    getClientPermissions(clientId) {
        return connectedClients.get(clientId)?.permissions;
    },

    setClientPermissions(clientId, permissions) {
        const client = connectedClients.get(clientId);
        if (client?.permissions) {
            client.permissions = { ...client.permissions, ...permissions };
        }
    },

    errorToResponse(e, request) {
        return {
            action: request?.action,
            error: e.message || 'Unknown error',
            errorCode: e.code || 0
        };
    },

    async handleRequest(request, connectionInfo) {
        const appWindowWasFocused = Launcher?.isAppFocused();

        let result;
        try {
            const handler = ProtocolHandlers[request.action];
            if (!handler) {
                throw new Error(`Handler not found: ${request.action}`);
            }
            result = await handler(request, connectionInfo);
            if (!result) {
                throw new Error(`Handler returned an empty result: ${request.action}`);
            }
        } catch (e) {
            if (!e.code) {
                logger.error(`Error in handler ${request.action}`, e);
            }
            result = this.errorToResponse(e, request);
        }

        if (!appWindowWasFocused && Launcher?.isAppFocused()) {
            Launcher.hideApp();
        }

        return result;
    },

    get sessions() {
        return [...connectedClients.entries()]
            .map(([clientId, client]) => ({
                clientId,
                connectionId: client.connection.connectionId,
                appName: client.connection.appName,
                extensionName: client.connection.extensionName,
                connectedDate: client.stats.connectedDate,
                passwordsRead: client.stats.passwordsRead,
                passwordsWritten: client.stats.passwordsWritten,
                permissions: client.permissions,
                permissionsDenied: client.permissionsDenied
            }))
            .sort((x, y) => y.connectedDate - x.connectedDate);
    }
};

export { ProtocolImpl };
