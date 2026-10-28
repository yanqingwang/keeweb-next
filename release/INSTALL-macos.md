# KeeWeb Next — macOS install

Built from `yanqingwang/keeweb-next` on macOS arm64 (Apple Silicon), version `0.1.0`.

## Files

| File | Purpose |
| --- | --- |
| `KeeWeb-Next_0.1.0_aarch64.dmg` | Installer image — drag **KeeWeb Next** into *Applications* |
| `KeeWeb-Next_0.1.0_aarch64.app.zip` | Portable `.app` bundle |
| `SHA256SUMS.txt` | Checksums |

## Install

1. Open the `.dmg` (or unzip the `.app.zip`) and drag **KeeWeb Next** to `/Applications`.
2. First launch: the build is **ad-hoc signed and not notarized**, so macOS Gatekeeper will block it.
   Use either:
   - Right-click the app → **Open** → **Open**, or
   - `xattr -dr com.apple.quarantine "/Applications/KeeWeb Next.app"`
3. The app is a Tauri webview shell around the local KeeWeb web build — no network access is required to open a `.kdbx` vault.

## Rebuild

```bash
./build-macos.sh
```

The script pins Node 24 LTS at `~/.local/node24/node-v24.22.1-darwin-arm64` (the repo's grunt/webpack
toolchain fails to install under the workspace's default Node 26), runs `npm run build:web`, then
`npx tauri build --bundles dmg,app`, and copies the results into `release/`.
