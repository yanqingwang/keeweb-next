// WebAuthn (passkey) support for the KeePassXC-Browser protocol.
//
// The extension does the browser side: it hooks navigator.credentials.create
// and .get, parses the options and hands them over as plain JSON. This module
// plays the authenticator — it validates the request, creates the credential
// key pair and later signs assertions with it.
//
// The extension is not a trust boundary. A hostile page can put anything into
// PublicKeyCredentialCreationOptions, so origin, rpId, challenge and user id
// are validated here before any key is created or used.

import { getDomain } from 'tldts';

// Not a registered AAGUID: the spec only requires it to be stable and
// non-zero, and a real registration would claim to be another authenticator.
const AAGUID = new Uint8Array([
    0x6b,
    0x65,
    0x65,
    0x77,
    0x65,
    0x62,
    0x2d,
    0x6e,
    0x65,
    0x78,
    0x74,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01
]);

const Flags = {
    UP: 0x01,
    UV: 0x04,
    BE: 0x08,
    BS: 0x10,
    AT: 0x40,
    ED: 0x80
};

// COSE algorithm identifiers, https://www.iana.org/assignments/cose/cose.xhtml
const Alg = {
    ES256: -7,
    EdDSA: -8,
    RS256: -257
};

const CREDENTIAL_ID_LENGTH = 32;
const MIN_CHALLENGE_LENGTH = 16;
const MAX_USER_ID_LENGTH = 64;

// KeePassXC entry fields; keeping the same names means a database opened by
// both apps shows one set of passkeys instead of two.
const Field = {
    RELYING_PARTY: 'KPEX_PASSKEY_RELYING_PARTY',
    USERNAME: 'KPEX_PASSKEY_USERNAME',
    KPXC_USERNAME: 'KPXC_PASSKEY_USERNAME',
    CREDENTIAL_ID: 'KPEX_PASSKEY_CREDENTIAL_ID',
    GENERATED_USER_ID: 'KPEX_PASSKEY_GENERATED_USER_ID',
    PRIVATE_KEY_PEM: 'KPEX_PASSKEY_PRIVATE_KEY_PEM',
    USER_HANDLE: 'KPEX_PASSKEY_USER_HANDLE',
    FLAG_BE: 'KPEX_PASSKEY_FLAG_BE',
    FLAG_BS: 'KPEX_PASSKEY_FLAG_BS'
};

const PASSKEY_FIELDS = [
    Field.RELYING_PARTY,
    Field.CREDENTIAL_ID,
    Field.GENERATED_USER_ID,
    Field.PRIVATE_KEY_PEM
];

// KDBX field names are case-insensitive (EntryModel.getFieldValue lowercases
// both sides), so a prefix test has to be too: otherwise a database written by
// another tool with "kpex_passkey_*" would be excluded by one code path and
// still readable through another.
const PASSKEY_FIELD_PREFIX = 'KPEX_PASSKEY_';

function isPasskeyFieldName(name) {
    return typeof name === 'string' && name.toUpperCase().startsWith(PASSKEY_FIELD_PREFIX);
}

// True when the entry holds passkey credential material, regardless of how
// the fields are capitalised.
function hasPasskeyField(entry) {
    if (!entry || typeof entry.getAllFields !== 'function') {
        return false;
    }
    return Object.keys(entry.getAllFields()).some(isPasskeyFieldName);
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function concatBytes(parts) {
    let length = 0;
    for (const part of parts) {
        length += part.length;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function bytesToBase64(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i++) {
        binary += String.fromCharCode(view[i]);
    }
    return btoa(binary);
}

function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// WebAuthn carries binary data as unpadded base64url
function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text) {
    if (typeof text !== 'string') {
        throw new Error('expected a base64url string');
    }
    const standard = text.replace(/-/g, '+').replace(/_/g, '/');
    const padding = standard.length % 4 ? '='.repeat(4 - (standard.length % 4)) : '';
    return base64ToBytes(standard + padding);
}

function toPem(pkcs8) {
    const body = bytesToBase64(pkcs8).replace(/(.{64})/g, '$1\n');
    return (
        '-----BEGIN PRIVATE KEY-----\n' + body.replace(/\n$/, '') + '\n-----END PRIVATE KEY-----\n'
    );
}

function fromPem(pem) {
    return base64ToBytes(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
}

// ---------------------------------------------------------------------------
// CBOR, encode only: WebAuthn needs a handful of fixed shapes, so a full
// codec would be dead weight.
// ---------------------------------------------------------------------------

function cborHead(majorType, value) {
    if (value < 24) {
        return [((majorType << 5) | value) & 0xff];
    }
    if (value < 0x100) {
        return [((majorType << 5) | 24) & 0xff, value & 0xff];
    }
    if (value < 0x10000) {
        return [((majorType << 5) | 25) & 0xff, (value >> 8) & 0xff, value & 0xff];
    }
    return [
        ((majorType << 5) | 26) & 0xff,
        (value >>> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff
    ];
}

function cborInt(value) {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
}

function cborText(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    return cborHead(3, bytes.length).concat(bytes);
}

function cborByteString(bytes) {
    const list = Array.from(new Uint8Array(bytes));
    return cborHead(2, list.length).concat(list);
}

function cborMap(entries) {
    let out = cborHead(5, entries.length);
    for (const [key, value] of entries) {
        out = out.concat(key, value);
    }
    return out;
}

// COSE_Key for an EC2 P-256 public key, https://www.rfc-editor.org/rfc/rfc9053
function coseEncodeEc2(x, y) {
    return new Uint8Array(
        cborMap([
            [cborInt(1), cborInt(2)], // kty: EC2
            [cborInt(3), cborInt(Alg.ES256)],
            [cborInt(-1), cborInt(1)], // crv: P-256
            [cborInt(-2), cborByteString(x)],
            [cborInt(-3), cborByteString(y)]
        ])
    );
}

// Attestation object with fmt "none", https://w3c.github.io/webauthn/#attestation-object
function cborEncodeAttestation(authenticatorData) {
    return new Uint8Array(
        cborMap([
            [cborText('fmt'), cborText('none')],
            [cborText('attStmt'), cborMap([])],
            [cborText('authData'), cborByteString(authenticatorData)]
        ])
    );
}

// ---------------------------------------------------------------------------
// DER, for ECDSA signatures
// ---------------------------------------------------------------------------

function derLength(length) {
    if (length < 0x80) {
        return [length];
    }
    const bytes = [];
    let value = length;
    while (value > 0) {
        bytes.unshift(value & 0xff);
        value >>= 8;
    }
    return [0x80 | bytes.length, ...bytes];
}

function derInteger(bytes) {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
        start++;
    }
    let value = Array.from(bytes.slice(start));
    if (value[0] & 0x80) {
        value = [0, ...value];
    }
    return [0x02, ...derLength(value.length), ...value];
}

// WebCrypto hands back r||s; WebAuthn wants SEQUENCE { INTEGER r, INTEGER s }
function derEncodeSignature(rawSignature) {
    const half = rawSignature.length / 2;
    const body = derInteger(rawSignature.slice(0, half)).concat(
        derInteger(rawSignature.slice(half))
    );
    return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function parseOrigin(origin) {
    if (typeof origin !== 'string' || !origin) {
        return null;
    }
    try {
        return new URL(origin);
    } catch {
        return null;
    }
}

function isOriginAllowed(origin, allowLocalhost) {
    const url = parseOrigin(origin);
    if (!url) {
        return false;
    }
    if (url.protocol === 'https:') {
        return true;
    }
    if (!allowLocalhost) {
        return false;
    }
    const host = url.hostname.toLowerCase();
    return (
        host === 'localhost' ||
        host === 'localhost.' ||
        host.endsWith('.localhost') ||
        host.endsWith('.localhost.')
    );
}

function isIpAddress(host) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

// The public suffix list decides which parent domain a site may claim. A
// hardcoded subset of second-level registries (co.uk, com.cn, ...) is always
// behind: shared hosting suffixes such as github.io or s3.amazonaws.com would
// slip through and let one tenant register or sign for every other tenant.
// getDomain() also returns null for non-registrable hosts, hence the fallback
// to the single-label rule.
const TldOptions = { allowPrivateDomains: true };

function isPublicSuffix(candidate) {
    if (candidate.indexOf('.') < 0) {
        return true; // a single label is always a TLD
    }
    return getDomain(candidate, TldOptions) !== candidate;
}

function normalizeDomain(host) {
    // a trailing dot is the same domain ("shop.co.uk." resolves to
    // "shop.co.uk"), but it would compare unequal and dodge every suffix check
    return typeof host === 'string' ? host.toLowerCase().replace(/\.$/, '') : '';
}

function isLocalhostName(host) {
    const name = normalizeDomain(host);
    return name === 'localhost' || name.endsWith('.localhost');
}

// The RP ID is either the origin's effective domain or a registrable suffix
// of it. Claiming a parent domain is only allowed when that parent really is
// the registrable domain: otherwise a tenant of a shared-hosting suffix could
// sign for every other tenant under it.
function validateRpId(rpId, effectiveDomain, allowLocalhost) {
    const domain = normalizeDomain(effectiveDomain);
    if (!domain) {
        return null;
    }
    // An IP literal is not a registrable domain, so it can neither be an RP ID
    // nor a suffix of one. Rejecting it up front also stops the suffix test
    // below from accepting something like "0.0.1" for "127.0.0.1".
    if (isIpAddress(domain)) {
        return null;
    }
    // http://localhost is only reachable when the user opted in, and the
    // public suffix list knows nothing about it: localhost is special-cased
    // the same way browsers special-case it.
    if (allowLocalhost && isLocalhostName(domain)) {
        const candidate =
            rpId === undefined || rpId === null || rpId === '' ? domain : normalizeDomain(rpId);
        if (candidate === domain || candidate === 'localhost') {
            return candidate;
        }
        return null;
    }
    // WebAuthn defaults rp.id to the caller's effective domain. That domain
    // still cannot be a public suffix: an origin served from "https://co.uk"
    // must not be able to claim the whole registry.
    if (rpId === undefined || rpId === null || rpId === '') {
        return isPublicSuffix(domain) ? null : domain;
    }
    if (typeof rpId !== 'string') {
        return null;
    }
    const candidate = normalizeDomain(rpId);
    // An origin served from a public suffix may not claim it either, so this
    // check comes before the equality shortcut.
    if (!candidate || isIpAddress(candidate) || isPublicSuffix(candidate)) {
        return null;
    }
    if (candidate === domain) {
        return candidate;
    }
    if (!domain.endsWith('.' + candidate)) {
        return null;
    }
    if (getDomain(domain, TldOptions) !== candidate) {
        return null;
    }
    return candidate;
}

function effectiveDomainOf(origin) {
    const url = parseOrigin(origin);
    return url ? normalizeDomain(url.hostname) : '';
}

// Origin as the browser serialises it: no default port, no trailing dot. It
// is what the user is shown and what goes into clientDataJSON, so the dialog
// cannot claim a host the signature does not belong to.
function normalizeOrigin(origin) {
    const url = parseOrigin(origin);
    return url ? url.origin : '';
}

function checkChallenge(challenge) {
    if (typeof challenge !== 'string' || !challenge) {
        return false;
    }
    try {
        return base64UrlToBytes(challenge).length >= MIN_CHALLENGE_LENGTH;
    } catch {
        return false;
    }
}

function checkUserId(userId) {
    if (typeof userId !== 'string' || !userId) {
        return false;
    }
    try {
        const length = base64UrlToBytes(userId).length;
        return length >= 1 && length <= MAX_USER_ID_LENGTH;
    } catch {
        return false;
    }
}

function buildClientDataJson({ type, challenge, origin }) {
    // Key order matters, https://w3c.github.io/webauthn/#clientdatajson-serialization
    return JSON.stringify({ type, challenge, origin, crossOrigin: false });
}

async function buildAuthenticatorData({ rpId, flags, attested }) {
    const rpIdHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId))
    );
    const parts = [rpIdHash, new Uint8Array([flags]), new Uint8Array([0, 0, 0, 0])];
    if (attested) {
        const id = attested.credentialId;
        parts.push(AAGUID);
        parts.push(new Uint8Array([(id.length >> 8) & 0xff, id.length & 0xff]));
        parts.push(id);
        parts.push(attested.coseKey);
    }
    return concatBytes(parts);
}

// ---------------------------------------------------------------------------
// Authenticator
// ---------------------------------------------------------------------------

async function createCredential() {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify'
    ]);
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    return {
        coseKey: coseEncodeEc2(base64UrlToBytes(jwk.x), base64UrlToBytes(jwk.y)),
        spki,
        privateKeyPem: toPem(pkcs8)
    };
}

async function signAssertion(privateKeyPem, authenticatorData, clientDataJson) {
    const key = await crypto.subtle.importKey(
        'pkcs8',
        fromPem(privateKeyPem),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    );
    const clientDataHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientDataJson))
    );
    const signed = concatBytes([authenticatorData, clientDataHash]);
    const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signed)
    );
    return derEncodeSignature(raw);
}

function randomCredentialId() {
    return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(CREDENTIAL_ID_LENGTH)));
}

// Builds the PublicKeyCredential the extension hands back to the page.
async function registerCredential({ options, origin, rpId }) {
    const credentialId = randomCredentialId();
    const { coseKey, privateKeyPem } = await createCredential();
    const clientDataJson = buildClientDataJson({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin
    });
    const authenticatorData = await buildAuthenticatorData({
        rpId,
        // no UV: the user clicked "Allow", which is presence, not
        // verification. Claiming otherwise would tell the site that a
        // biometric or PIN check happened when none did.
        flags: Flags.UP | Flags.BE | Flags.BS | Flags.AT,
        attested: { credentialId: base64UrlToBytes(credentialId), coseKey }
    });
    const attestationObject = cborEncodeAttestation(authenticatorData);
    return {
        credentialId,
        privateKeyPem,
        userHandle: options.user.id,
        response: {
            authenticatorAttachment: 'platform',
            id: credentialId,
            type: 'public-key',
            response: {
                attestationObject: bytesToBase64Url(attestationObject),
                clientDataJSON: bytesToBase64Url(new TextEncoder().encode(clientDataJson)),
                authenticatorData: bytesToBase64Url(authenticatorData),
                transports: ['internal', 'hybrid'],
                clientExtensionResults: {}
            }
        }
    };
}

async function assertCredential({
    challenge,
    origin,
    rpId,
    credentialId,
    privateKeyPem,
    userHandle,
    userVerified
}) {
    const clientDataJson = buildClientDataJson({
        type: 'webauthn.get',
        challenge,
        origin
    });
    // The UV bit claims the authenticator verified the user. Only set it when
    // the caller actually showed a confirmation the user answered; an
    // unattended signature must not claim user verification.
    const flags = Flags.UP | Flags.BE | Flags.BS | (userVerified ? Flags.UV : 0);
    const authenticatorData = await buildAuthenticatorData({ rpId, flags });
    const signature = await signAssertion(privateKeyPem, authenticatorData, clientDataJson);
    return {
        authenticatorAttachment: 'platform',
        id: credentialId,
        type: 'public-key',
        response: {
            authenticatorData: bytesToBase64Url(authenticatorData),
            clientDataJSON: bytesToBase64Url(new TextEncoder().encode(clientDataJson)),
            signature: bytesToBase64Url(signature),
            userHandle: userHandle || null,
            clientExtensionResults: {}
        }
    };
}

export {
    AAGUID,
    Field,
    PASSKEY_FIELDS,
    assertCredential,
    base64UrlToBytes,
    buildAuthenticatorData,
    buildClientDataJson,
    bytesToBase64Url,
    cborEncodeAttestation,
    checkChallenge,
    checkUserId,
    coseEncodeEc2,
    derEncodeSignature,
    effectiveDomainOf,
    hasPasskeyField,
    isOriginAllowed,
    isPasskeyFieldName,
    normalizeDomain,
    normalizeOrigin,
    registerCredential,
    validateRpId
};
