import { expect } from 'chai';
import * as kdbxweb from 'kdbxweb';
import { KdbxwebInit } from 'util/kdbxweb/kdbxweb-init';

const Signature1 = 0x9aa2d903;
const Signature2 = 0xb54bfb67;

function bytesWithHeader(versionMinor, versionMajor) {
    const data = new Uint8Array(16);
    const view = new DataView(data.buffer);
    view.setUint32(0, Signature1, true);
    view.setUint32(4, Signature2, true);
    view.setUint16(8, versionMinor, true);
    view.setUint16(10, versionMajor, true);
    return data.buffer;
}

function credentials() {
    return new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString('test'));
}

describe('KDBX version compatibility', () => {
    before(() => {
        // saving KDBX4 needs Argon2; the app registers it at startup, the
        // test bundle does not load the app
        KdbxwebInit.init();
    });

    it('opens a version 4.1 header the way KeePass 2.61 writes it', () => {
        const db = kdbxweb.Kdbx.create(credentials(), 'compat');
        db.header.versionMajor = 4;
        db.header.versionMinor = 1;
        return db.save().then((bytes) => {
            return kdbxweb.Kdbx.load(bytes, credentials()).then((loaded) => {
                expect(loaded.header.versionMajor).to.equal(4);
                expect(loaded.header.versionMinor).to.equal(1);
            });
        });
    });

    it('rejects a version above the supported 4.1', () => {
        const data = bytesWithHeader(2, 4);
        return kdbxweb.Kdbx.load(data, credentials()).then(
            () => {
                throw new Error('loading a future version must fail');
            },
            (err) => {
                expect(err.code).to.equal(kdbxweb.Consts.ErrorCodes.InvalidVersion);
            }
        );
    });
});
