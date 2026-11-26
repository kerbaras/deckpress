# Changelog

## v0.1.0

### Added

- Lay out cards for Silhouette Card Maker cutting templates. Pick a built-in template or import one, and use the alignment guides to prepare the sheet. (#45, #61)
- See token suggestions for your deck and import or export MPC Autofill XML. (#49)
- Start your first deck by importing a list, using the guided builder, starting with a blank deck, or trying a sample. (#58)
- Export a cut-template SVG for free layouts. (#64)
- Calibrate duplex alignment with back-side offsets and rotation, and save corrections as reusable printer profiles. (#72)

### Fixed

- Choose an explicit print size and see the physical dimensions on the sheet. Print at actual size to preserve those dimensions. (#26)
- Detect bleed already present in uploaded card images so it is not added twice. (#48)
- Keep the correct back artwork for double-faced cards. (#49)
- Show actionable errors for unsupported import URLs and partial card lists. (#47)
- Return focus to the URL field when an import retry fails. (#69)
- Include calibration pages in the PDF page count shown in Print Setup. (#59)
- Improve focus visibility, control contrast, and readability in the compact title bar and SCM picker. (#55)
- Protect selected cards in the guided builder when changing an earlier choice. (#44)
- Only show cut files available in Silhouette Card Maker's `cutting_templates` folder. (#77)
- Reduce repetitive screen-reader announcements in style matching and confirm cut-template saves. (#81)
- Align preview pagination with exported sheets and clarify when to use calibration. (#82)
- Verify the quality upscaling model before using it and allow failed downloads to be retried. (#27)

### Build and tests

- Run the full web and Rust checks on every pull request and test SCM geometry against reference fixtures. (#30, #25)
- Package Windows installers for x64 and Arm64 and publish installers for all five build targets on version tags. (#66)
