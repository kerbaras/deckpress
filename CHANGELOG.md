# Changelog

## v0.1.0

### Added

- Choose from all 114 built-in Silhouette Card Maker default paper and card layouts, select a three- or four-mark pattern, and find the filename and link for the matching cutter template when available. (#45, #61)
- See token suggestions for your deck and import or export MPC Autofill XML. (#49)
- Start your first deck by importing a list, using the guided builder, starting with a blank deck, or trying a sample. (#58)
- Export a cut-template SVG for free layouts. (#64)
- Calibrate duplex alignment with back-side offsets and rotation, and save corrections as reusable printer profiles. (#72)
- Compare how upscaling models render a card crop, and move the comparison area on the card thumbnail. (#60, #100)
- Set an ordered list of preferred print languages. Mark English fallbacks, or use strict mode to list unavailable cards without importing them. (#50)
- Choose a light or dark theme, or follow the system setting. (#76)
- Export individual card faces as PNG files at the selected print resolution in a ZIP archive. (#68)
- Find PNG, MPC, and SVG exports in the Other exports menu, with PDF kept as the primary export. (#127)
- Change essential print settings beside the proof and jump directly to controls that are blocking export. (#108)
- Edit bleed on saved art uploads without re-uploading them. Backup and restore preserve the setting. (#109)
- In Print Jobs, use Retry to queue a failed export with its original settings when available. Back to print setup opens the proof without queuing a job and focuses the failing card or Model setting when identified. (#104)
- Import companions into a dedicated Companion zone and print them alongside the main deck by default. (#128)
- Prefer higher-quality Scryfall scans that keep the same illustration and language. Check effective source DPI and whether AI upscaling will apply to MPC images in Print Setup. (#105)
- Use localized printings that keep the same illustration, and preview and apply art policies across the deck without overwriting custom artwork. Undo last art change reverses the most recent policy application in one step. (#106)

### Fixed

- Choose an explicit card size and see the trim dimensions in Print Setup. Print at 100% / actual size with fit-to-page turned off. (#26)
- Estimate common source bleed sizes from uploaded image proportions and strip the detected or specified bleed before applying print settings. (#48)
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
- Point blocked Moxfield imports to the plain-text export and preserve custom board names through backup and restore. Warn when unrecognized CSV boards default to Mainboard, and list malformed rows with their original line numbers in a separate CSV errors group. Companion headings no longer go to card lookup. (#80, #107, #102)
- Distinguish original art, saved art, and unapplied previews. Confirm before switching card faces or leaving Art Studio with an unapplied preview. (#75, #112, #120)
- Show how many art matches are loaded when results are filtered or paginated. (#114)
- Cancel an upscale comparison while its images are downloading or its model is loading. (#99)
- Restore the selected duplex printer profile after restarting. (#96)
- Move keyboard focus to the active step in the guided builder and improve label and field visibility. (#92, #101)
- Announce print jobs, downloads, exports, duplex calibration, and other status updates without repetitive screen-reader messages. (#71, #90, #117)
- Keep the save indicator clear of the workspace tabs, expose the Saving… state to screen readers, and keep editing while a toolbar save is in progress. (#89)
- Use the correct singular and plural forms in card and builder counts, deck-search and style-match explanations, and job progress. (#95, #97, #103, #118)
- Trim bleed from saved upload thumbnails, prune superseded variants, and clean up legacy thumbnail cache entries. (#131, #135)
- Keep the sticky proof from covering Print check. (#134)
- Detect CSV deck lists after leading blank lines and comments, report errors with the original file line numbers, and honor a leading `// Board:` comment as the starting board. (#136)
- Show loading labels immediately and announce them to screen readers for Art Studio editions, Discover search and deck previews, commander search, and guided builder startup, scoring, counting, and draftable sets. Workspace opening, Library, and print jobs keep their existing announcements. (#121)

### Build and tests

- Run the full web and Rust checks on every pull request and test SCM geometry against reference fixtures. (#30, #25)
- Package Windows installers for x64 and Arm64 and publish installers for all five build targets on version tags. (#66, #67)
- Restore Apple Silicon installer builds and let an active nightly Build on main finish when newer commits arrive. (#124)
