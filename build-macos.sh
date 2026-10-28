#!/usr/bin/env bash
# Build the macOS installer (dmg + .app zip) for keeweb-next.
#
# Requirements (both already present in this workspace):
#   - Node 24 LTS at ~/.local/node24/node-v24.22.1-darwin-arm64
#     (the system node 26 breaks the legacy webpack/grunt toolchain setup)
#   - Rust toolchain (cargo/rustc on PATH)
#
# Output: release/KeeWeb-Next_<version>_<arch>.dmg and .app.zip

set -euo pipefail

cd "$(dirname "$0")"

NODE_DIR="${NODE24_DIR:-$HOME/.local/node24/node-v24.22.1-darwin-arm64}"
if [ -x "$NODE_DIR/bin/node" ]; then
    export PATH="$NODE_DIR/bin:$PATH"
fi
echo "node: $(node -v)  npm: $(npm -v)"

# The lockfile references keeweb git forks; npm 11 needs these flags plus a
# clean user config (the user's ~/.npmrc carries allow-scripts for other pkgs).
if [ ! -d node_modules ]; then
    npm_config_userconfig=/dev/null npm ci --allow-git=all --allow-remote=all --no-audit --no-fund
fi

# Web app first: src-tauri/tauri.conf.json bundles ../dist as frontendDist.
npm run build:web

# Native shell + installer bundles.
npx tauri build --bundles dmg,app

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
ARCH=$(uname -m)
BUNDLE=src-tauri/target/release/bundle

mkdir -p release
cp "$BUNDLE/dmg/KeeWeb Next_${VERSION}_${ARCH}.dmg" "release/KeeWeb-Next_${VERSION}_${ARCH}.dmg"
(cd "$BUNDLE/macos" && zip -qry "$OLDPWD/release/KeeWeb-Next_${VERSION}_${ARCH}.app.zip" "KeeWeb Next.app")

echo
ls -lh release/
shasum -a 256 release/* | tee "release/SHA256SUMS.txt"
