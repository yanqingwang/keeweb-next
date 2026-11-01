// Builds the native-messaging helper and puts it where Tauri's externalBin
// bundling expects it: src-tauri/binaries/<name>-<host-triple>[.exe].
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(
    /^host: (.+)$/m
)[1];
const exe = process.platform === 'win32' ? '.exe' : '';
const helperTarget = join(root, 'src-tauri', 'target', 'browser-host');

execFileSync(
    'cargo',
    [
        'build',
        '--manifest-path',
        join(root, 'src-tauri', 'browser-host', 'Cargo.toml'),
        '--target-dir',
        helperTarget,
        '--release',
        '--bin',
        'keeweb-next-browser-host'
    ],
    { stdio: 'inherit' }
);

const out = join(root, 'src-tauri', 'binaries');
mkdirSync(out, { recursive: true });
const source = join(helperTarget, 'release', `keeweb-next-browser-host${exe}`);
const target = join(out, `keeweb-next-browser-host-${triple}${exe}`);
copyFileSync(source, target);
if (process.platform !== 'win32') {
    chmodSync(target, 0o755);
}
console.log(`native messaging host: ${target}`);
