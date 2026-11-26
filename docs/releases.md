# Desktop releases

1. On main, verify that CI and all five jobs in the Build matrix are green.
2. Keep the versions in the root, desktop, and web `package.json` files, both Rust crate manifests, and the desktop `tauri.conf.json` in sync. Add the release notes under a heading such as `## v0.1.0` in `CHANGELOG.md` before tagging.
3. From the verified main commit, create an annotated tag and check it before pushing:

   ```sh
   git tag -a v0.1.0 -m "Deckpress v0.1.0"
   node scripts/check-release.mjs v0.1.0
   git push origin v0.1.0
   ```

The script checks the tagged commit, not your working tree. It prints the release notes if the tag is annotated, all six manifest versions match it, and the changelog section is nonempty.

The Build workflow runs the same check before starting any packaging job for a version tag. It packages Linux x64 and Arm64, macOS Arm64, and Windows x64 and Arm64. When all five jobs succeed, it publishes a GitHub Release named after the tag with the installers and the validated notes. Pushes to main continue to replace the separate `nightly` prerelease.
