# Deckpress

Deckpress is a local desktop app for printing Magic: The Gathering proxies. Import a deck list, pick art, and export a print-ready PDF.

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
