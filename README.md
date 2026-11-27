# Deckpress

Deckpress is a local desktop app for printing Magic: The Gathering proxies. Import a deck list, pick art, and export a print-ready PDF.

## Web preview

Open the [Deckpress web preview](https://kerbaras.github.io/deckpress/) in up-to-date desktop Chrome. Import a pasted or saved decklist, resolve it with Scryfall, and export a PDF or PNG ZIP at 600 DPI by default. Print Setup also offers matching SVG, DXF, or Silhouette Studio cut files depending on the layout. The Silhouette archive downloads the first time you use it.

- Use HTTPS or localhost. The service worker reloads the page when it first takes control and supplies the cross-origin isolation headers required for threaded WASM. WebGPU needs a compatible GPU and driver with `shader-f16`. The browser tries WebGPU first, then threaded WASM when isolated, then single-threaded WASM. Chrome 137 or later is recommended.
- The default General x4v3 model and the faster Anime model download from the site on first use and are checked against their SHA-256 hashes. After an online export you can reopen the site and export the same deck offline, as long as Chrome retains the app, model, and scans. Pick a smaller sheet range if a large export exhausts available memory.
- Decks, settings, and uploaded art are kept in browser storage. Settings shows storage usage and can clear models, scans, and cached Scryfall data. Backups reference uploads without embedding them. Restoring one asks once for the original files and matches them by content hash, or by filename for older backups without a hash.
- In the art picker, "Use <Set> for the whole deck" previews moving each unpinned Scryfall card to that set family. The Deck language selector previews each reprint before it changes the deck.
- MPC Autofill (including backups with MPC art), deck URL imports (paste the list instead), Discover, the deck builder, and printer queues require the desktop app.
- Verified in Chrome with WebGPU on macOS and Linux. Safari is untested.

### Build the web preview

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
pnpm install --frozen-lockfile
pnpm build:wasm
VITE_TARGET=web pnpm --filter @deckpress/web build
VITE_TARGET=web pnpm --filter @deckpress/web preview --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173/deckpress/`. The production artifact is in `apps/web/dist-pages`. To publish it, the repository's Pages source must be set to GitHub Actions. The Pages workflow builds on pull requests and deploys from `main`.

## Install

Download an installer from the [latest release](https://github.com/kerbaras/deckpress/releases/latest), or try the newest main build from the [`nightly`](https://github.com/kerbaras/deckpress/releases/tag/nightly) prerelease.

- macOS (Apple silicon): DMG
- Windows x64 and Arm64: MSI or NSIS setup
- Linux x64 and Arm64: DEB, RPM or AppImage

### macOS

The macOS build is ad-hoc signed and not notarized until a Developer ID is set up for the project ([#144](https://github.com/kerbaras/deckpress/issues/144)). Gatekeeper blocks it the first time you open a copy downloaded in a browser.

1. Drag Deckpress to Applications and open it once. macOS refuses to open it.
2. Open System Settings > Privacy & Security, scroll to Security, and click Open Anyway for Deckpress. Confirm, and enter your password if asked.

On macOS 15 and later, Control-click > Open no longer skips this check.

If macOS says Deckpress "is damaged and can't be opened", remove the download quarantine flag in Terminal and open the app again:

```sh
xattr -dr com.apple.quarantine /Applications/Deckpress.app
```

## Development

See [AGENTS.md](AGENTS.md) for the toolchain and checks, and [docs/releases.md](docs/releases.md) for the release steps.

## License

Deckpress is released under the [MIT License](LICENSE). The bundled Real-ESRGAN models are BSD-3-Clause (see `packages/core/models.json`), and the JetBrains Mono font is under the SIL Open Font License 1.1.
