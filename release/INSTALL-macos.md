# KeeWeb Next — macOS install

Built from `yanqingwang/keeweb-next`, version `0.1.2`, macOS arm64 (Apple Silicon).

## Download

Grab `KeeWeb-Next_0.1.2_aarch64.dmg` (or `…​.app.zip`) from the GitHub **Releases**
page for tag `v0.1.2`. The binaries are not committed to the repository —
`SHA256SUMS.txt` next to this file lists their checksums.

## Install

1. Open the `.dmg` (or unzip the `.app.zip`) and drag **KeeWeb Next** into `/Applications`.
2. First launch: the build is **ad-hoc signed and not notarized**, so Gatekeeper blocks it.
   Use either
   - right-click the app → **Open** → **Open**, or
   - `xattr -dr com.apple.quarantine "/Applications/KeeWeb Next.app"`
3. Do **not** run it straight from the disk image: Gatekeeper then starts it from a random
   read-only path, which breaks the browser integration (its host manifest would point at a
   temporary location).

## KeePassXC-Browser integration

The app registers itself as the native-messaging host `org.keepassxc.keepassxc_browser`
(after KeePassXC's own host name, so the stock extension connects unchanged).

On macOS the manifests are written to

| Browser | Manifest |
| --- | --- |
| Firefox | `~/Library/Application Support/Mozilla/NativeMessagingHosts/org.keepassxc.keepassxc_browser.json` |
| Chrome / Chromium / Edge / Brave / Vivaldi | `~/Library/Application Support/<Browser>/NativeMessagingHosts/org.keepassxc.keepassxc_browser.json` |

The manifest points at `KeeWeb Next.app/Contents/MacOS/keeweb-next-browser-host`; the
browser starts that helper, which talks to the running app over
`~/Library/Application Support/KeeWeb Next/browser/browser.sock`.

Usage:

1. Launch **KeeWeb Next** (the integration is installed at startup; the settings page has a
   switch that removes or restores the manifests).
2. Click the KeePassXC-Browser toolbar icon → **Connect**. A vault does *not* have to be
   open to associate; reading or saving passwords does.

### If the extension still says it cannot connect

Check the three things the extension needs:

```bash
ls -l  ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/
ls -l  ~/Library/Application\ Support/KeeWeb\ Next/browser/browser.sock
pgrep -fl "KeeWeb Next"
```

- **manifest missing** → the app has not been launched yet, or the integration is switched
  off in *Settings → Browser integration*.
- **socket missing** → the app is not running.
- **app installed elsewhere** (not `/Applications`) → move it there and restart it so the
  manifest is rewritten with the new path.
- **KeePassXC also installed** → both write the same host name; the last one launched wins.
  Quit KeePassXC and restart KeeWeb Next.

If Firefox was already running when the manifest appeared, it picks it up without a restart,
but the extension may need a reconnect from its popup.

## Rebuild

```bash
./build-macos.sh
```

The script pins Node 24 LTS at `~/.local/node24/node-v24.22.1-darwin-arm64` (the repo's
grunt/webpack toolchain fails to install under the workspace's default Node 26), runs
`npm run build:web`, then `npx tauri build --bundles dmg,app`, and copies the results into
`release/` with checksums.
