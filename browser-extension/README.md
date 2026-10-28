# KeeWeb Next Browser Connect (Chrome, Chromium, Edge)

A Manifest V3 extension that talks to the desktop shell's KeePassHTTP
endpoint at `http://127.0.0.1:19455`. It exists because KeePassXC-Browser
cannot be used here: that extension only speaks KeePassXC's native-messaging
protocol, while KeeWeb Next exposes KeePassHTTP.

The Firefox variant of the same extension lives in
[../browser-extension-firefox](../browser-extension-firefox).

## Install

1. Start the app and unlock a database.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → pick this `browser-extension` directory. With the Arch
   package it is installed to `/usr/share/keeweb-next/browser-extension`.
4. Open any login page, click the KeeWeb Next icon and **Connect to the app**.
   The app asks once for permission.
5. Focusing a login field opens a small menu with the entries matching that
   host; picking one fills the form. The popup also lists the matches and can
   save the credentials currently typed into the page.

The manifest carries a fixed `key`, so the extension id
(`eipadpfnlelphokdheneficndgfibnna`) stays stable between installs.

## Notes

- The app must be running and the database unlocked; associations live in the
  app process and are forgotten when it quits, so the extension asks to
  connect again after a restart.
- Matching uses the page host against the entry's URL (subdomains count).
- The key never leaves the extension and the local app; all traffic stays on
  the loopback interface.

## Third-party extensions

Any client speaking KeePassHTTP works the same way; chromeIPass (Chrome/Edge)
and KeePassHttp-Connector (Firefox) are the common ones. KeePassXC-Browser is
not compatible.
