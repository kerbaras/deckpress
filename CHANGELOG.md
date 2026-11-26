# Changelog

## v0.1.0

### Added

- Lay out cards for Silhouette Card Maker cutting templates. Pick a built-in template or import one, and use the alignment guides to prepare the sheet. (#45, #61)
- See token suggestions for your deck and import or export MPC Autofill XML. (#49)

### Fixed

- Choose an explicit print size and see the physical dimensions on the sheet. Print at actual size to preserve those dimensions. (#26)
- Detect bleed already present in uploaded card images so it is not added twice. (#48)
- Keep the correct back artwork for double-faced cards. (#49)
- Show actionable errors for unsupported import URLs and partial card lists. (#47)
- Verify the quality upscaling model before using it and allow failed downloads to be retried. (#27)

### Build and tests

- Run the full web and Rust checks on every pull request and test SCM geometry against reference fixtures. (#30, #25)
- Package Windows installers for x64 and Arm64 and publish installers for all five build targets on version tags. (#66)
