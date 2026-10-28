import { expect } from 'chai';
import { StorageWebDav } from 'storage/impl/storage-webdav';

// Regression tests for servers that do not send Last-Modified (Nutstore among
// them). Opening used to fail with "last modified http header is absent"; the
// storage now continues without a revision and only compares revisions that
// actually exist.

const RealXhr = window.XMLHttpRequest;

function installFakeXhr(respond) {
    const requests = [];

    class FakeXhr {
        constructor() {
            this.listeners = {};
            this.requestHeaders = {};
            this.status = 0;
            this.response = null;
            this.responseHeaders = {};
        }

        open(method, url) {
            this.method = method;
            this.url = url;
        }

        setRequestHeader(name, value) {
            this.requestHeaders[name.toLowerCase()] = value;
        }

        addEventListener(name, handler) {
            (this.listeners[name] = this.listeners[name] || []).push(handler);
        }

        getResponseHeader(name) {
            const value = this.responseHeaders[name.toLowerCase()];
            return value === undefined ? null : value;
        }

        send(body) {
            const response = respond(this.method, this.url, body);
            requests.push({ method: this.method, url: this.url, body });
            this.status = response.status;
            this.responseHeaders = response.headers || {};
            this.response = response.body || new ArrayBuffer(0);
            (this.listeners.load || []).forEach((handler) => handler());
        }
    }

    window.XMLHttpRequest = FakeXhr;
    return requests;
}

function makeStorage() {
    const storage = new StorageWebDav();
    storage.appSettings = {
        webdavStatReload: false,
        webdavSaveMethod: 'default',
        webdav: true
    };
    return storage.init();
}

describe('StorageWebDav without Last-Modified', () => {
    afterEach(() => {
        window.XMLHttpRequest = RealXhr;
    });

    it('loads a database when the header is absent', (done) => {
        installFakeXhr(() => ({ status: 200, headers: {} }));
        const storage = makeStorage();
        storage.load('/db.kdbx', {}, (err, data, stat) => {
            expect(err).to.equal(null);
            expect(stat).to.eql({ rev: null });
            done();
        });
    });

    it('still reports the revision when the server sends one', (done) => {
        installFakeXhr(() => ({
            status: 200,
            headers: { 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }
        }));
        const storage = makeStorage();
        storage.stat('/db.kdbx', {}, (err, stat) => {
            expect(err).to.equal(null);
            expect(stat.rev).to.equal('Wed, 21 Oct 2015 07:28:00 GMT');
            done();
        });
    });

    it('saves a database when the server has no revision to compare', (done) => {
        const requests = installFakeXhr(() => ({ status: 200, headers: {} }));
        const storage = makeStorage();
        storage.save('/db.kdbx', {}, new Uint8Array([1, 2, 3]), (err, stat) => {
            expect(err).to.equal(null);
            expect(stat).to.eql({ rev: null });
            expect(requests.map((r) => r.method)).to.eql(['HEAD', 'PUT', 'HEAD', 'MOVE', 'HEAD']);
            done();
        });
    });

    it('keeps reporting a conflict when both revisions exist and differ', (done) => {
        installFakeXhr(() => ({
            status: 200,
            headers: { 'last-modified': 'Thu, 22 Oct 2015 07:28:00 GMT' }
        }));
        const storage = makeStorage();
        storage.save(
            '/db.kdbx',
            {},
            new Uint8Array([1, 2, 3]),
            (err) => {
                expect(err).to.eql({ revConflict: true });
                done();
            },
            'Wed, 21 Oct 2015 07:28:00 GMT'
        );
    });
});
