# Desktop releases

1. On main, verify that CI and all five jobs in the Build matrix are green.
2. Keep the versions in the root, desktop, and web `package.json` files, both Rust crate manifests, and the desktop `tauri.conf.json` in sync. Add the release notes under a heading such as `## v0.1.0` in `CHANGELOG.md` before tagging.
3. From the verified main commit, create and push an annotated tag:

   ```sh
   git tag -a v0.1.0 -m "Deckpress v0.1.0"
   git push origin v0.1.0
   ```

The Build workflow packages Linux x64 and Arm64, macOS Arm64, and Windows x64 and Arm64. When all five jobs succeed, it publishes a GitHub Release named after the tag with the installers and the matching changelog section. Pushes to main continue to replace the separate `nightly` prerelease.
