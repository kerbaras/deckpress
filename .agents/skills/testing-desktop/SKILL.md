---
name: testing-desktop
description: Run and test the native Deckpress Tauri app on Linux, including print exports and ONNX CPU inference.
---

# Native desktop runtime tests

## Devin Secrets Needed

None for local decks, bundled inference, public Scryfall/MPC searches, or public URL imports.

## Launch

- Use the pinned pnpm and Node 24. `pnpm dev` launches Tauri and starts Vite; visiting Vite in Chrome does not exercise native IPC or the dpimg protocol.
- Check for an existing Deckpress process before starting another. Coordinate source edits with the recording operator because the Tauri watcher rebuilds and restarts the window.
- The Cargo workspace builds the development executable under the repository-root `target/debug`, with the engine in `packages/core-rs`. After a workspace/export refactor, a long-lived Vite process may show a blank native window with a missing named-export error; restart both Tauri and Vite before classifying it as a clean-start failure.
- On Ubuntu 22.04 with the official dynamic ONNX Runtime installed, launch from the repo root:

```sh
export DISPLAY=:0
export ORT_LIB_LOCATION="$HOME/onnxruntime/onnxruntime-linux-x64-1.23.2/lib"
export ORT_PREFER_DYNAMIC_LINK=1
export LD_LIBRARY_PATH="$ORT_LIB_LOCATION${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export RUST_LOG=info
pnpm dev
```

- Adjust the ONNX path to the installed version. Do not assume a standalone release binary resolves its bundled resources the same way as an installed package or `tauri dev`.
- Use `wmctrl -a Deckpress` and `wmctrl -r Deckpress -b add,maximized_vert,maximized_horz` before recording.
- For responsive checks, inspect the native minimum width in `tauri.conf.json` and measure actual restored-window bounds with `wmctrl -lG` after edge resizing. Tool screenshots use scaled coordinates, not necessarily CSS pixels; do not claim a breakpoint passed when the native size limit prevented reaching it.
- Settings shows the data directory and model status. A bundled model's Load button should produce `Loaded · CPU` on a CPU-only Linux host.
- Data normally lives under `~/.local/share/dev.kerbaras.deckpress`. Use `DECKPRESS_DATA_DIR` before launch when test isolation is needed. Backups reference uploaded images, so retain the data directory when checking restore.

## Exercise the real native paths

- Decks > New deck > Decklist: paste a small list, Resolve on Scryfall, then Add to deck. Resolving alone does not save cards.
- Clicking a card opens Art studio. Apply saves the chosen art. Favorite/rating are stored separately; verify them after a process restart.
- The Upload dialog uses a native file chooser. Ctrl+L accepts an absolute fixture path. A text file renamed `.png` tests content validation despite the file filter.
- Print setup has AI, model and calibration controls below geometry. Preview is 150 DPI without AI; final exports use the chosen DPI.
- For cancellation, choose an uncached source/model pair; an already-cached AI export may finish before the Cancel click.
- Save as and library Backup use native dialogs. Absolute paths can be entered in the filename field. Use newly created test decks for deletion.

## Inspect saved files

- `pip install --user pymupdf` provides PDF parsing and rendering if Poppler is unavailable.
- At default 63x88 mm card dimensions with 1 mm bleed, embedded image bounds should be 65x90 mm. Vector cut positions should delimit 63x88 mm. Convert PDF points with `mm = points * 25.4 / 72`.
- A one-sheet fronts-only export with calibration has two pages. Long-edge duplex with calibration has four: calibration, its mostly blank reverse, fronts, mirrored backs.
- Render PDF pages and compare matching card crops, not different printings, when judging AI sharpness. PDF page counts or byte size alone do not demonstrate image quality.
- Test Open PDF and Show file separately from export. This remote Linux desktop may have no `application/pdf` MIME default or working desktop D-Bus integration. Check `xdg-mime query default application/pdf`, `xdg-mime query default inode/directory`, process responsiveness, and runtime logs. A saved valid PDF does not prove those integration actions work.
