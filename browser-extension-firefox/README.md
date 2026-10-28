# KeeWeb Next Browser Connect (Firefox)

The Firefox build of the extension that ships with the app. It speaks the same
KeePassHTTP protocol as the Chrome/Chromium one
([../browser-extension](../browser-extension)); only the browser APIs and the
manifest differ.

## Install

1. Start the KeeWeb Next app and unlock a database.
2. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary
   Add-on** and pick `manifest.json` in this folder.
   For a permanent install, pack the folder:
   `web-ext build` (or zip it) and install the `.zip` through
   `about:addons` → Install Add-on From File, with signing disabled for
   self-distribution.
3. Click the KeeWeb Next icon and **Connect to the app**; the app asks once for
   permission.

Focusing a login field on any page opens a small menu with the saved logins
for that host; picking one fills the form. The popup can also save the
credentials currently typed into the page.

The endpoint is `http://127.0.0.1:19455` on the loopback interface only; the
association key never leaves the browser profile and the local app.
