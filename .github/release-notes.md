KeeWeb Next — KeeWeb in the system WebView, with a Tauri 2 shell.

**In 0.1.3 — password filling behaves like KeePassXC**

- `get-logins` now answers with every matching entry (capped at 30) instead of
  a single best match. The extension compares what a page submits against that
  list, so the single-match reply made it offer to *save* a password it had
  just handed out — and answering “yes” created a duplicate entry. Multi-account
  sites are picked in the extension’s own popup, no dialog in the app window.
- The extension permission dialog can be remembered (“remember this choice”,
  on by default), so it does not reappear after every restart; Settings →
  Browser can show and clear that decision, leads with KeePassXC-Browser
  (including download links) and shows live sessions.
- First-time requests now raise the app window: `Launcher.showMainWindow` was a
  no-op in the webview shell, so the dialog waited invisibly while the browser
  appeared to do nothing.
- The About page library versions are injected from package.json at build time
  (and a URL that was rendering as a version is gone).

**Fixes in 0.1.2 — KeePassXC-Browser could not connect**

- macOS: the native-messaging manifests were only written to the Linux paths
  (`~/.config`, `~/.mozilla`), so Firefox never found the host. They now go to
  `~/Library/Application Support/{<browser>,Mozilla}/`.
- macOS: preparing the socket directory tried to `chmod 0700` its parent, which
  was `/tmp` — the call failed and the browser bridge never started. The socket
  now lives in a per-user directory under the app's own support folder.
- Association and `get-databasehash` no longer require an open vault, matching
  KeePassXC. Previously the extension saw “database closed” and refused to
  associate at all, which looked like “cannot connect”.

**Highlights**

- WebDAV without CORS limits (Nutstore, Nextcloud, any WebDAV), tolerant of
  servers that omit `Last-Modified`.
- Built-in translations: 简体中文, 繁體中文, 日本語, 한국어, English, Deutsch, Français.
- Browser integration two ways:
  - KeePassXC-Browser over native messaging (`org.keepassxc.keepassxc_browser`),
  - a bundled KeePassHTTP extension for Chrome/Edge and Firefox, and any
    KeePassHTTP client (chromeIPass, KeePassHttp-Connector).
- Signed plugin gallery shipped in the repository (quick-search, copy-hotkeys,
  open-url, password-age, duplicate-finder).
- History of open databases pinned like bookmarks (five recent entries),
  WebDAV credentials and key files remembered.

**Downloads**

- `*.AppImage`, `*.deb`, `*.rpm` — Linux
- `*.dmg` / `*.app.zip` — macOS (Apple Silicon)
- `*.msi`, `*.exe` — Windows
- `keeweb-next-web.zip` — the web app, for self-hosting

Arch Linux users: the package is attached to this release as
`keeweb-next-<ver>-x86_64.pkg.tar.zst` (install with `pacman -U`), or build
from `packaging/arch/PKGBUILD` in the repository.
