// Signs every plugin in this directory and regenerates plugins.json.
//
// KeeWeb verifies each resource with the key named in the manifest's publicKey,
// and verifies the gallery itself; both use RSASSA-PKCS1-v1_5 over SHA-256.
// The shell trusts app/resources/public-key.pem and public-key-new.pem; this
// fork's key lives in signing/public-key.pem and is installed as the second one.
//
// Usage: node plugins/signing/sign.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginsRoot = path.dirname(here);
const repoRoot = path.dirname(pluginsRoot);

const privateKey = fs.readFileSync(path.join(here, 'private-key.pem'), 'utf8');
const publicKeyPem = fs.readFileSync(path.join(here, 'public-key.pem'), 'utf8');
const publicKey = publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

const appPublicKey = fs
    .readFileSync(path.join(repoRoot, 'app/resources/public-key-new.pem'), 'utf8')
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
if (appPublicKey !== publicKey) {
    throw new Error('app/resources/public-key-new.pem does not match signing/public-key.pem');
}

const galleryBase = 'https://raw.githubusercontent.com/yanqingwang/keeweb-next/master/plugins';

function sign(data) {
    return crypto.sign('sha256', data, privateKey).toString('base64');
}

function pluginDirs() {
    return fs
        .readdirSync(pluginsRoot, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                entry.name !== 'signing' &&
                fs.existsSync(path.join(pluginsRoot, entry.name, 'manifest.json'))
        )
        .map((entry) => entry.name)
        .sort();
}

const galleryPlugins = [];

for (const name of pluginDirs()) {
    const dir = path.join(pluginsRoot, name);
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const resources = {};
    const signatures = {};
    for (const [type, file] of Object.entries({ js: 'plugin.js', css: 'plugin.css', loc: null })) {
        if (!file) {
            continue;
        }
        const resourcePath = path.join(dir, file);
        if (!fs.existsSync(resourcePath)) {
            continue;
        }
        const data = fs.readFileSync(resourcePath);
        resources[type] = data;
        signatures[type] = sign(data);
    }
    manifest.resources = signatures;
    manifest.publicKey = publicKey;
    manifest.url = `${galleryBase}/${name}`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n');

    galleryPlugins.push({ url: manifest.url, official: true, manifest });
    console.log(`signed ${name}: ${Object.keys(signatures).join(', ')}`);
}

const gallery = {
    date: new Date().toISOString(),
    signature: '',
    plugins: galleryPlugins
};
gallery.signature = sign(JSON.stringify(gallery, null, 2));
fs.writeFileSync(path.join(pluginsRoot, 'plugins.json'), JSON.stringify(gallery, null, 2) + '\n');
console.log(`gallery: ${galleryPlugins.length} plugins`);
