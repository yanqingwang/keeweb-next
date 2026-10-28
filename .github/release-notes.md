KeeWeb Next — KeeWeb in the system WebView, with a Tauri 2 shell.

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
