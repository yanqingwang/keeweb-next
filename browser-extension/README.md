# KeeWeb Next Browser Connect

A small Manifest V3 extension that talks to the desktop shell's KeePassHTTP
endpoint at `http://127.0.0.1:19455`. It exists because KeePassXC-Browser
cannot be used here: that extension only speaks KeePassXC's native-messaging
protocol, while KeeWeb Next exposes KeePassHTTP.

## Install (Chrome, Edge, Chromium)

1. Start the app and unlock a database.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → pick this `browser-extension` directory. With the Arch
   package it lives at `/usr/share/keeweb-next/browser-extension`.
4. Open any login page, click the KeeWeb Next icon and **Connect to the app**.
   The app asks once for permission.
5. Focusing a login field on any page opens a small menu with the entries
   matching that host; picking one fills the form. The popup also lists the
   matches and can save the credentials currently typed into the page.

## Firefox

Firefox needs `manifest.firefox.json` renamed to `manifest.json`; the
service-worker background is replaced by an event page there. Load it with
`about:debugging` → **Load Temporary Add-on**.

## Third-party extensions

Any client speaking KeePassHTTP works the same way; chromeIPass (Chrome/Edge)
and KeePassHttp-Connector (Firefox) are the common ones. KeePassXC-Browser is
not compatible.

## Notes

- The app must be running and the database unlocked; associations live in the
  app process and are forgotten when it quits, so the extension asks to
  connect again after a restart.
- Matching uses the page host against the entry's URL (subdomains count).
- The key never leaves the extension and the local app; all traffic stays on
  the loopback interface.
