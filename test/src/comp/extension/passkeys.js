import { expect } from 'chai';
import {
    base64UrlToBytes,
    bytesToBase64Url,
    checkChallenge,
    checkUserId,
    derEncodeSignature,
    effectiveDomainOf,
    hasPasskeyField,
    isOriginAllowed,
    isPasskeyFieldName,
    registerCredential,
    assertCredential,
    validateRpId
} from 'comp/extension/passkeys';

function base64UrlOf(length) {
    return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

describe('Passkeys', () => {
    describe('origin and rpId validation', () => {
        it('accepts https origins only', () => {
            expect(isOriginAllowed('https://example.com', true)).to.be.true;
            expect(isOriginAllowed('http://example.com', true)).to.be.false;
            expect(isOriginAllowed('file:///tmp/page.html', true)).to.be.false;
        });

        it('accepts localhost when allowed', () => {
            expect(isOriginAllowed('http://localhost:8080', true)).to.be.true;
            expect(isOriginAllowed('http://app.localhost', true)).to.be.true;
            expect(isOriginAllowed('http://localhost:8080', false)).to.be.false;
        });

        it('rejects garbage origins', () => {
            expect(isOriginAllowed('', true)).to.be.false;
            expect(isOriginAllowed('not a url', true)).to.be.false;
            expect(isOriginAllowed(undefined, true)).to.be.false;
        });

        it('defaults the rpId to the effective domain', () => {
            expect(validateRpId(undefined, 'example.com')).to.equal('example.com');
            expect(validateRpId('', 'example.com')).to.equal('example.com');
            expect(validateRpId('example.com', 'example.com')).to.equal('example.com');
        });

        it('accepts a parent domain but not a sibling one', () => {
            expect(validateRpId('example.com', 'login.example.com')).to.equal('example.com');
            expect(validateRpId('example.org', 'login.example.com')).to.be.null;
            expect(validateRpId('other.com', 'example.com')).to.be.null;
        });

        // without a public-suffix list a bare TLD would let any site claim
        // every site under that TLD
        it('rejects a bare top level domain', () => {
            expect(validateRpId('com', 'example.com')).to.be.null;
            expect(validateRpId('localhost', 'app.localhost')).to.be.null;
        });

        // WebAuthn forbids IP literals as RP IDs: they are not registrable
        // domains, and a suffix match would otherwise accept "0.0.1"
        it('rejects an IP address as rpId', () => {
            expect(validateRpId('127.0.0.1', '127.0.0.1')).to.be.null;
            expect(validateRpId(undefined, '127.0.0.1')).to.be.null;
            expect(validateRpId('0.0.1', '127.0.0.1')).to.be.null;
            expect(validateRpId('::1', '::1')).to.be.null;
        });

        // a public suffix may not be claimed as an RP ID, not even as the
        // origin's own effective domain
        it('rejects common second-level public suffixes', () => {
            expect(validateRpId('co.uk', 'shop.co.uk')).to.be.null;
            expect(validateRpId('com.cn', 'shop.com.cn')).to.be.null;
            expect(validateRpId(undefined, 'co.uk')).to.be.null;
            expect(validateRpId(undefined, 'com.cn')).to.be.null;
        });

        // shared hosting domains are public suffixes too: a hardcoded list of
        // ccTLD registries never keeps up with them, and a tenant must not be
        // able to sign for every other tenant under the same suffix
        it('rejects shared-hosting suffixes', () => {
            expect(validateRpId('github.io', 'victim.github.io')).to.be.null;
            expect(validateRpId(undefined, 'github.io')).to.be.null;
            expect(validateRpId('s3.amazonaws.com', 'evil.s3.amazonaws.com')).to.be.null;
        });

        it('normalises a trailing dot before comparing', () => {
            expect(validateRpId('co.uk.', 'shop.co.uk.')).to.be.null;
            expect(validateRpId('example.com', 'login.example.com.')).to.equal('example.com');
        });

        // http://localhost is only reachable when the user opted in, and the
        // public suffix list does not cover it
        it('accepts localhost only when it is allowed', () => {
            expect(validateRpId(undefined, 'localhost')).to.be.null;
            expect(validateRpId(undefined, 'localhost', true)).to.equal('localhost');
            expect(validateRpId('localhost', 'localhost', true)).to.equal('localhost');
            expect(validateRpId('app.localhost', 'app.localhost', true)).to.equal('app.localhost');
            expect(validateRpId('example.com', 'localhost', true)).to.be.null;
        });

        it('reads the effective domain from an origin', () => {
            expect(effectiveDomainOf('https://Login.Example.com:8443')).to.equal(
                'login.example.com'
            );
            expect(effectiveDomainOf('nonsense')).to.equal('');
        });
    });

    describe('option validation', () => {
        it('requires a challenge of at least 16 bytes', () => {
            expect(checkChallenge(base64UrlOf(16))).to.be.true;
            expect(checkChallenge(base64UrlOf(15))).to.be.false;
            expect(checkChallenge('')).to.be.false;
            expect(checkChallenge(undefined)).to.be.false;
        });

        it('limits the user id to 64 bytes', () => {
            expect(checkUserId(base64UrlOf(1))).to.be.true;
            expect(checkUserId(base64UrlOf(64))).to.be.true;
            expect(checkUserId(base64UrlOf(65))).to.be.false;
            expect(checkUserId(base64UrlOf(0))).to.be.false;
        });
    });

    describe('encoding', () => {
        it('round-trips base64url', () => {
            const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x3e]);
            const encoded = bytesToBase64Url(bytes);
            expect(encoded).to.not.contain('=');
            expect(encoded).to.not.contain('+');
            expect(encoded).to.not.contain('/');
            expect(Array.from(base64UrlToBytes(encoded))).to.eql(Array.from(bytes));
        });

        it('encodes an ECDSA signature as a DER sequence', () => {
            const raw = new Uint8Array(64);
            raw.fill(0x01);
            const der = derEncodeSignature(raw);
            expect(der[0]).to.equal(0x30);
            // two INTEGERs of 32 bytes each, no padding needed
            expect(der[1]).to.equal(0x44);
            expect(der[2]).to.equal(0x02);
            expect(der[3]).to.equal(0x20);
        });

        it('pads a DER integer whose top bit is set', () => {
            const raw = new Uint8Array(64);
            raw.fill(0x80);
            const der = derEncodeSignature(raw);
            // 33-byte integers: a 0x00 prefix keeps the value positive
            expect(der[2]).to.equal(0x02);
            expect(der[3]).to.equal(0x21);
            expect(der[4]).to.equal(0x00);
        });
    });

    describe('credentials', () => {
        const origin = 'https://example.com';
        const rpId = 'example.com';

        it('registers a credential the extension can hand to the page', async () => {
            const options = {
                challenge: base64UrlOf(32),
                user: { id: base64UrlOf(16), name: 'user@example.com' },
                rp: { id: rpId, name: 'Example' }
            };
            const credential = await registerCredential({ options, origin, rpId });

            expect(credential.credentialId).to.be.a('string');
            expect(credential.privateKeyPem).to.contain('BEGIN PRIVATE KEY');
            expect(credential.response.type).to.equal('public-key');
            expect(credential.response.id).to.equal(credential.credentialId);
            expect(credential.response.response.attestationObject).to.be.a('string');
            expect(credential.response.response.clientDataJSON).to.be.a('string');
            // the flags byte sits right after the rpIdHash: UP|BE|BS|AT, and
            // never UV, because a click on "Allow" is presence only
            const flags = base64UrlToBytes(credential.response.response.authenticatorData)[32];
            expect(flags & 0x04).to.equal(0);
            expect(flags & 0x01).to.equal(0x01);
        });

        it('signs an assertion that verifies against the registered key', async () => {
            const options = {
                challenge: base64UrlOf(32),
                user: { id: base64UrlOf(16), name: 'user@example.com' },
                rp: { id: rpId, name: 'Example' }
            };
            const credential = await registerCredential({ options, origin, rpId });
            const challenge = base64UrlOf(32);
            const assertion = await assertCredential({
                challenge,
                origin,
                rpId,
                credentialId: credential.credentialId,
                privateKeyPem: credential.privateKeyPem,
                userHandle: options.user.id
            });

            expect(assertion.id).to.equal(credential.credentialId);
            expect(assertion.response.userHandle).to.equal(options.user.id);

            const clientDataJson = new TextDecoder().decode(
                base64UrlToBytes(assertion.response.clientDataJSON)
            );
            expect(JSON.parse(clientDataJson)).to.eql({
                type: 'webauthn.get',
                challenge,
                origin,
                crossOrigin: false
            });
        });

        // the UV bit is a claim about the user, so it must follow the caller's
        // answer instead of being set unconditionally
        it('sets the UV flag only when the user was verified', async () => {
            const options = {
                challenge: base64UrlOf(32),
                user: { id: base64UrlOf(16), name: 'user@example.com' },
                rp: { id: rpId, name: 'Example' }
            };
            const credential = await registerCredential({ options, origin, rpId });
            const base = {
                challenge: base64UrlOf(32),
                origin,
                rpId,
                credentialId: credential.credentialId,
                privateKeyPem: credential.privateKeyPem,
                userHandle: options.user.id
            };
            // authenticatorData: rpIdHash(32) | flags(1) | counter(4)
            const verified = await assertCredential({ ...base, userVerified: true });
            const unverified = await assertCredential({ ...base, userVerified: false });
            const verifiedFlags = base64UrlToBytes(verified.response.authenticatorData)[32];
            const unverifiedFlags = base64UrlToBytes(unverified.response.authenticatorData)[32];

            expect(verifiedFlags & 0x04).to.equal(0x04);
            expect(unverifiedFlags & 0x04).to.equal(0);
            // UP is set either way: the user did answer a prompt
            expect(unverifiedFlags & 0x01).to.equal(0x01);
        });
    });

    describe('field names', () => {
        it('recognises passkey fields regardless of capitalisation', () => {
            expect(isPasskeyFieldName('KPEX_PASSKEY_PRIVATE_KEY_PEM')).to.be.true;
            expect(isPasskeyFieldName('kpex_passkey_private_key_pem')).to.be.true;
            expect(isPasskeyFieldName('Password')).to.be.false;
            expect(isPasskeyFieldName(undefined)).to.be.false;
        });

        it('spots passkey entries by their fields', () => {
            const fields = (names) => ({
                getAllFields: () => Object.fromEntries(names.map((n) => [n, 'x']))
            });
            expect(hasPasskeyField(fields(['Title', 'KPEX_PASSKEY_RELYING_PARTY']))).to.be.true;
            expect(hasPasskeyField(fields(['Title', 'UserName']))).to.be.false;
            expect(hasPasskeyField(undefined)).to.be.false;
        });
    });
});
