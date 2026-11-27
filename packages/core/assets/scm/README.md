# Silhouette Card Maker reference data

`layouts.json` and `LICENSE.md` are unmodified copies from
[Alan-Cha/silhouette-card-maker at 0da09b7](https://github.com/Alan-Cha/silhouette-card-maker/tree/0da09b729814aa5aafde024b5a6059624fa87951).
`cutting-templates.json` retains SCM's full `files` inventory and maps each
supported export under `exports` to its original path and SHA-256. The adjacent
ZIP contains those mapped files, bundled for offline export under SCM's MIT license
(`LICENSE.md`, also included in desktop installers under `THIRD_PARTY/`).
The manifest lists A3 and Arch B borderless exceptions: the virtual sheets
exceed the 12×24 mat, so SCM does not publish those Studio files.

Regenerate from the pinned SCM checkout with
`python scripts/bundle-scm-cut-files.py /path/to/silhouette-card-maker`.
See [the print production notes](../../../../docs/print-production.md#silhouette-card-maker-trim-fixture)
for the generated fixture's format and regeneration instructions.
