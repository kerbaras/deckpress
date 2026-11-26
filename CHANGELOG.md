# Changelog

## v0.1.0

### Added

- Lay out cards for Silhouette Card Maker cutting templates. Pick a built-in template or import one, and use the alignment guides to prepare the sheet. (#45, #61)
- See token suggestions for your deck and import or export MPC Autofill XML. (#49)
- Start your first deck by importing a list, using the guided builder, starting with a blank deck, or trying a sample. (#58)
- Export a cut-template SVG for free layouts. (#64)
- Calibrate duplex alignment with back-side offsets and rotation, and save corrections as reusable printer profiles. (#72)
- Compare how upscaling models render a card crop, and move the comparison area on the card thumbnail. (#60, #100)
- Set preferred print languages and see when a card falls back to English. (#50)
- Choose a light or dark theme, or follow the system setting. (#76)
- Export print-ready sheets as PNG files in a ZIP archive. (#68)
- Find PNG, MPC, and SVG exports in the Other exports menu, with PDF kept as the primary export. (#127)
- Change essential print settings beside the proof and jump directly to controls that are blocking export. (#108)

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
- Keep the focused import control in view on resize, show the loaded filename, and focus the deck heading after saving. (#87, #84)
- Point blocked Moxfield imports to the plain-text export, preserve custom board names through backup and restore, and report physical CSV line numbers for malformed rows. Companion headings no longer go to card lookup. (#80, #107, #102)
- Distinguish saved art from unapplied previews and confirm before switching card faces or leaving the art studio with an unapplied preview. (#75, #112, #120)
- Show how many art matches are loaded when results are filtered or paginated. (#114)
- Cancel an upscale comparison while its images are downloading or its model is loading. (#99)
- Restore the selected duplex printer profile after restarting. (#96)
- Move keyboard focus to the active step in the guided builder and improve label and field visibility. (#92, #101)
- Announce print jobs, downloads, exports, duplex calibration, and other status updates without repetitive screen-reader messages. (#71, #90, #117)
- Keep the save indicator clear of the workspace tabs. (#89)
- Use the correct singular and plural forms in card and builder counts, deck-search and style-match explanations, and job progress. (#95, #97, #103, #118)

### Build and tests

- Run the full web and Rust checks on every pull request and test SCM geometry against reference fixtures. (#30, #25)
- Package Windows installers for x64 and Arm64 and publish installers for all five build targets on version tags. (#66, #67)
- Restore Apple Silicon installer builds and let an active nightly Build on main finish when newer commits arrive. (#124)
