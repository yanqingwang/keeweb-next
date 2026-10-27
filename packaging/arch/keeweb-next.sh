#!/bin/sh
# Runs the web app from the installed files, in a browser of your choice.
# The Tauri shell (keeweb-next) needs no wrapper; this is the no-webview path.
exec ${BROWSER:-xdg-open} /usr/share/keeweb-next/dist/index.html
