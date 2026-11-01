# KeeWeb Next

[中文](README.md) | **English**

A local-first KeePass client that runs in your system WebView — no Electron.
Open `.kdbx` databases over WebDAV (Nutstore / Nextcloud / any WebDAV server),
use the same database from desktop and phone, and let browser extensions and
KeePass plugins talk to it over a localhost HTTP API.

The upstream is [KeeWeb](https://github.com/keeweb/keeweb) (MIT). This
repository is an adaptation: **the Electron 13 desktop shell is gone**,
replaced by an optional Tauri 2 WebView shell (the NoteForge architecture),
and WebDAV requests are moved down into Rust.

---

## Why not build from scratch

| Candidate | WebDAV | PC + phone | Browser extension | Verdict |
| --- | --- | --- | --- | --- |
| **KeeWeb** (this upstream) | built in (XHR) | Electron desktop / phone browser | **KeeWeb Connect exists** | lowest cost, chosen |
| KeePassXC | none (needs OS mount) | desktop only | KeePassXC-Browser exists | no phone story |
| Keepass2Android / KeePassDX | yes | Android only | none | no desktop |
| KeeStone (Flutter) | yes (conditional writes) | yes | none | 4-month-old upstream, single maintainer |
| Ground-up rewrite | write it | write it | write it | KDBX parsing/merge/attachments/history is years of edge cases; silent data corruption is unacceptable |

KeeWeb already ships full KDBX 3.1/4.x read/write, **conflict-free merge**,
attachments, history, TOTP, and a published browser extension protocol. What
it lacks is three things, all fixed in this repository:

1. The Electron 13 shell → Tauri 2 (system WebView, ~10 MB binary).
2. WebDAV from a browser dies on CORS (Nutstore sends no CORS headers) →
   requests execute in Rust.
3. Upstream kdbxweb 2.0.4 (2021) → upgraded to 2.1.1 with 4.1 compatibility
   tests.

## Architecture

```mermaid
flowchart LR
    subgraph webview["Tauri 2 WebView (optional shell)"]
        UI["KeeWeb Web UI<br/>(Backbone, kdbxweb)"]
    end
    subgraph rust["Rust shell process (src-tauri/)"]
        WD["webdav_request<br/>(reqwest, GET/PUT/MOVE/...)"]
        BR["browser_bridge<br/>(loopback random port + token)"]
    end
    UI -- "invoke('webdav_request')" --> WD
    WD -- "https" --> DAV["WebDAV server<br/>dav.jianguoyun.com etc."]
    UI -- "browser-rpc / replies" --> BR
    BR -- "native messaging" --> EXT["KeePassXC-Browser<br/>via keeweb-next-browser-host"]
```

* **Web mode (no shell)**: `dist/` is a static site that runs in any browser;
  local files use the File System Access API, WebDAV is subject to browser
  CORS.
* **WebView mode (the default desktop form)**: Tauri 2 loads the same `dist/`
  and executes WebDAV through Rust `reqwest` — no CORS, no Node, no bundled
  Chromium.
* **Browser integration**: native messaging only. Extensions hand their
  messages to the `keeweb-next-browser-host` helper, which forwards them to
  the shell over a random loopback port with a one-time token. There is no
  fixed port and no HTTP endpoint.

## Done (changes relative to upstream)

* Passkeys (WebAuthn) for KeePassXC-Browser: `passkeys-register` and
  `passkeys-get`, stored in entries using the KeePassXC `KPEX_PASSKEY_*`
  field names so one database works in both apps. The app reports KeePassXC
  `2.7.7` (the release the extension gates passkeys on) and creates ES256
  credentials with `fmt: none` attestation. Origin, RP ID and challenge are
  validated app-side: https only (`http://localhost` is opt-in and then works),
  RP ID must be the origin's effective domain or its registrable parent — the
  public suffix list (`tldts`, including private suffixes such as `github.io`)
  decides that, and bare TLDs, public suffixes and IP literals are refused.
  Assertions never set the UV bit: a click on "Allow" is presence, not
  verification, so sites asking for `userVerification: 'required'` get an
  explicit error. Confirmation dialogs are serialised, the chosen entry is
  re-resolved after the prompt, and passkey entries are hidden from
  `get-logins`, the field picker and `set-login`.

* Removed `desktop/`, Electron 13 and every electron/grunt packaging task;
  `package.json` no longer carries Electron, native-modules or
  native-messaging-host.
* Added `src-tauri/` (Tauri 2): loads `dist/` and exposes one command today,
  `webdav_request` (method whitelist GET/HEAD/PUT/POST/DELETE/MOVE/COPY/MKCOL/
  PROPFIND/OPTIONS, http/https only, 5-minute timeout, 512 MB cap, ≤5
  redirects).
* `storage-webdav.js` calls `invoke('webdav_request')` inside the shell; the
  response object keeps the XHR shape, so `Last-Modified` / 404 / 412
  semantics are unchanged.
* `kdbxweb` 2.0.4 → **2.1.1** (the git forks pako/xmldom replaced by registry
  packages).
* New browser tests (`test/src/util/kdbx-compat.js`): the KDBX 4.1 header
  KeePass 2.61 writes opens and saves; versions above 4.1 are refused.
  `npm test` is green (86 passing).
* Rust integration tests (`src-tauri/tests/webdav_mock.rs`): a local mock
  server proves the PUT carries `Content-Length` (not chunked), the Basic
  auth header, and the response headers/body round-trip.
* Arch packaging: `packaging/arch/PKGBUILD` (web app + shell binary).

## Not done yet / roadmap

* Phone: the Tauri 2 Android/iOS targets (icons already generated) plus a
  round of mobile UI adaptation.
* Official browser-extension pairing for autofill (KeePassXC-Browser over
  native messaging already works).
* Auto-update, tray, global shortcuts, auto-type: Electron-era features, not
  migrated yet.

## Build

Requirements: Node ≥ 20, Rust, `webkit2gtk-4.1` (Linux),
`clang/cmake/ninja/pkgconf`.

```bash
# Web app (no shell)
npm ci --allow-git=all --allow-remote=all   # needed when your npmrc bans git sources
npm run build:web                            # output in dist/

# WebView shell
npm run build:shell                          # src-tauri/target/release/keeweb-next
npm run dev:shell                            # dev mode (start `npm run dev` on :8085 first)

# Tests
npm test                                     # browser tests (see CHROME_BIN below)
(cd src-tauri && cargo test)                 # Rust side
```

`npm test` launches puppeteer; with a system Chromium set
`CHROME_BIN=/usr/bin/chromium`.

## macOS support

The shell is Tauri 2 + the system WKWebView (no bundled runtime, ~10 MB
binary):

* The window uses `titleBarStyle: Overlay` with `hiddenTitle` — the traffic
  lights float over the content and the title is hidden; `acceptFirstMouse`
  lets the first click on an unfocused window land in the webview.
* The in-app titlebar (minimize/maximize/close) goes through the
  `window_minimize` / `window_toggle_maximize` / `window_close` commands and
  renders on macOS too.
* Dragging: the hidden-titlebar strip carries `data-tauri-drag-region`.
* Icons: `icon.icns` ships in the bundle.
* Settings persist under
  `~/Library/Application Support/info.keeweb.next/config/`.
* CI builds natively on `macos-14` (Apple Silicon) and `macos-13` (Intel) and
  produces dmg/app bundles (`.github/workflows/build-next.yml`).

Not migrated yet: Touch ID / hardware-crypto storage (the Electron
hardware-crypto module), auto-type, global shortcuts, tray.

## Install (Arch Linux)

```bash
cd packaging/arch
makepkg -si          # installs /usr/bin/keeweb-next and /usr/share/keeweb-next/dist
```

* WebView form: run `keeweb-next`.
* Browser form (without the webkit dependency):
  `/usr/share/keeweb-next/dist/index.html`.

## Nutstore (坚果云) configuration

Pick **WebDAV** on the KeeWeb open screen:

| Field | Value |
| --- | --- |
| URL | `https://dav.jianguoyun.com/dav/my-vault/db.kdbx` |
| Username | your Nutstore account email |
| Password | an **application password** (generated on the website under account security, not the login password) |

* The parent folder must exist; if the file does not, the first open creates it.
* Free accounts allow 600 WebDAV requests per 30 minutes; an open is one GET,
  a save is one PUT — well inside the limit.
* Known quirks: 411 (Content-Length required — shell PUTs satisfy it), 503
  (rate limited).
* Servers that do not send `Last-Modified` still open fine: revision-based
  conflict detection is skipped in that case. Enable "always reload the file"
  in the file settings if you want change detection anyway.

## Support and contact

If this app saves you some time, you can buy me a coffee; the official account
carries release notes in Chinese.

| WeChat reward code | WeChat official account |
| --- | --- |
| <img src="app/content/img/reward-qr.jpg" width="180" alt="WeChat reward code"> | <img src="app/content/img/wechat-official.jpg" width="180" alt="WeChat official account"> |

Email: <wangyantsing@qq.com>

## Data and security

* The database is decrypted locally; WebDAV only ever carries ciphertext. The
  master password and key file are never written to disk.
* The shell's `webdav_request` allows only the methods WebDAV needs and only
  http/https; it is not a generic proxy.
* Browser integration uses native messaging only: no fixed port, no HTTP
  endpoint. The helper talks to the shell over a random loopback port with a
  one-time token in a 0600 file that no web page can read.
* MIT, same as upstream; upstream docs live in
  [docs/README.upstream.md](docs/README.upstream.md).
