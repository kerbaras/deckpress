# Desktop releases

1. After the intended changes have merged, finalize the version's section in `CHANGELOG.md` against the latest main. Include the user-facing changes since the previous release and use a heading such as `## v0.1.0`.
2. Keep the versions in the root, desktop, and web `package.json` files, both Rust crate manifests, and the desktop `tauri.conf.json` in sync with the changelog version, without the `v` prefix. Merge the release-prep PR.
3. Verify that CI and all five Build jobs passed on the exact main commit to release. Check out that commit, then create and validate an annotated tag before pushing:

   ```sh
   git tag -a v0.1.0 -m "Deckpress v0.1.0" &&
   node scripts/check-release.mjs v0.1.0 &&
   git push origin v0.1.0
   ```

The script checks the tagged commit, not your working tree. It prints the release notes if the tag is annotated, all six manifest versions match it, and the changelog section is nonempty.

The Build workflow runs the same check before starting any packaging job for a version tag. When all five jobs succeed, it publishes a GitHub Release named after the tag with the validated notes. Check the release for all 11 installers: DEB, RPM, and AppImage for each of Linux x64 and Arm64; a DMG for macOS Arm64; and MSI and NSIS for each of Windows x64 and Arm64.

Pushes to main continue to replace the separate `nightly` prerelease.

## macOS signing

The Build workflow signs and notarizes the macOS app only when all six repository secrets exist: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` (the "Configure macOS signing" step in `.github/workflows/build.yml`). Without them the DMG is ad-hoc signed, Gatekeeper rejects browser downloads, and users need the workaround in the README.

A green Build run does not prove the app was signed. The macOS job logs a notice for each missing secret. To check a DMG, copy its app to Applications and run:

```sh
codesign -dv --verbose=2 /Applications/Deckpress.app
spctl -a -vv /Applications/Deckpress.app
```

A signed build shows `Authority=Developer ID Application: ...` and a `TeamIdentifier`, and `spctl` reports `accepted` with `source=Notarized Developer ID`. `flags=0x20002(adhoc,linker-signed)` or `rejected` means the build is ad-hoc signed.
