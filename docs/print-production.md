# Print production notes

What commercial print shops do when they gang several pieces onto one sheet
and cut them apart, and how Deckpress maps those conventions onto a home or
copy-shop printer. Sources were prepress guides from trade printers and
imposition software vendors, the PDF/X family of standards, and print-and-play
board game guides; the numbers below are the values those guides agree on.

## Imposition

- Ganging: identical or mixed pieces are laid out in a grid on a larger parent
  sheet. Cards go 9-up on A4/Letter (3 × 3), 18-up on A3/Tabloid.
- Gutters: pieces either butt against each other (shared cut, one knife pass)
  or sit apart with a gutter at least as wide as two bleeds. A shared cut is
  faster; gutters are more forgiving when the sheet shifts.
- Duplex: backs are imposed mirrored around the sheet's flip axis (long-edge or
  short-edge). Nothing else changes; the trim geometry is identical on both
  sides so one set of marks serves front and back.

Deckpress: `apps/web/src/core/layout.ts` and `packages/core/src/layout.rs`
compute the same grid from the paper size, card size, bleed and gap. Backs are
mirrored per the chosen flip axis.

## Bleed and safe area

- Bleed: artwork extends past the trim line so a slightly off cut does not
  leave a white edge. 3 mm (1/8 in) is the commercial default; 1–2 mm is usual
  for cards because the cut is closer to the art and card faces have a border.
- Safe area: keep anything important 3 mm inside the trim. Card frames already
  do this.

Deckpress: default 1 mm bleed, configurable. MPC-style images that already
carry bleed are recognised and their bleed is trimmed before ours is applied so
the physical card stays 63 × 88 mm (63.5 × 88.9 mm for MPC's 2.5 × 3.5 in).

The bleed strip is filled in one of three ways (Print setup › Bleed › Fill):

- Mirror (default): the card face is reflected about its outermost row and
  column of pixels, so a cut that drifts outward lands on border-coloured
  pixels instead of a flat colour. The outermost pixel is the axis and is not
  repeated; the reflection keeps folding when the bleed is wider than the face.
- Edge: the outermost row and column are stretched outward.
- Solid: a flat colour, the only mode that uses the colour picker.

Mirror and Edge sample a copy of the face whose 3 mm corner zones have been
squared off from the border (each pixel outside the corner arc takes the pixel
on the arc), and they do so before the rounded corners are painted. Scans with
transparent or white corners, such as Scryfall PNGs, therefore mirror border
pixels into the bleed rather than the corner colour. The corner fill (3 mm
radius) uses the same colour as solid bleed and only touches the trim area.
Decks saved with an explicit mode keep it; only new or unspecified settings
pick up the default.

## Marks

- Crop (trim) marks: short hairlines aligned with each trim edge, drawn in the
  margin, offset from the trim so they never touch the bleed. Typical values:
  0.25 pt stroke (0.1–0.15 mm), 2–5 mm long, 0.5–1 mm outside the bleed.
- Interior marks: when pieces have gutters, marks are repeated in the gutter
  so each piece can be cut independently. With shared cuts the outer marks
  alone define every line.
- Registration marks: crossed circles placed symmetrically on the sheet, used
  to check that front and back (or multiple colour passes) line up. Only
  meaningful for duplex or multi-pass work.
- Slug: a small label in the margin with the job name, sheet number, side and
  key settings. Keeps a stack of sheets sortable and lets you tell which
  settings produced a proof.
- Marks are printed in registration black (all inks) in press work; on a
  desktop printer plain black or dark grey is equivalent.

Deckpress (`guides: "crop"`):

- Outer marks on all four margins for every trim line, 0.25 pt, 2 mm long,
  0.5 mm outside the bleed (all three adjustable in Print setup).
- Interior ticks inside every gutter that has room (two bleeds plus gap must
  exceed the offset on both sides), so every card has its own cut marks.
- Registration targets centred in the top and side margins (where they fit)
  and a slug line when the deck prints duplex.
- `guides: "full"` draws complete cut lines across the sheet for people who
  cut with a rotary trimmer and want to see the line under the blade.
- `guides: "none"` produces a clean page.

## Resolution

- Commercial minimum: 300 ppi at final size for photographs, 600–1200 ppi for
  line art and small type. Card text is line art in practice.
- Above the printer's native resolution there is no gain: most inkjets image
  at 600–1200 dpi, laser printers at 600 dpi, and any extra pixels are
  resampled by the driver.

Deckpress: preview at 150 dpi, export at 300 (proof), 600, 800 (default) or
1200 dpi. A Scryfall PNG is roughly 300 ppi at card size; the optional 4×
Real-ESRGAN pass supplies the extra pixels, then the result is downsampled to
the requested dpi. Physical size never depends on the raster resolution.

## Colour

- Press workflows deliver CMYK (or CMYK plus spot) with an output intent for
  the intended press and paper (FOGRA39, GRACoL 2006, and so on) and embed it
  in a PDF/X-1a or PDF/X-4 file. Fonts are embedded, transparency is either
  flattened (X-1a) or allowed (X-4), and the TrimBox and BleedBox are set so
  the imposition software knows where the trim is.
- Desktop and copy-shop printers expect RGB. Their drivers convert to the
  device's inks; sending CMYK to them usually makes colours worse, not better.
- sRGB is the assumed colour space for untagged RGB content. Scryfall scans and
  most community images are sRGB.

Deckpress today: RGB PDF, untagged (treated as sRGB by every viewer and
driver), fonts embedded, no PDF/X claim. This is the right target for home and
copy-shop printing. If a user needs a press-ready file, the missing pieces are
an sRGB output intent (cheap), TrimBox/BleedBox on each page (cheap), and a
CMYK conversion with a chosen profile (needs a colour management library);
none of these are implemented yet and the app does not claim they are.

## Printing at home

- Print at 100% / actual size. "Fit to page", "shrink to printable area" and
  borderless modes all rescale the sheet.
- Measure the ruler on the print-size calibration page before a full run.
  On standard sheets, also check the 63 × 88 mm reference box; a 1% scale error
  is 0.9 mm on a card. Very small custom sheets use a compact ruler and omit
  the box if it would not fit.
- Use the heaviest paper the printer feeds reliably (200–300 gsm card stock)
  or print on plain paper and sleeve with a real card behind it.
- For duplex, print one sheet first and hold it against a light to check
  front/back registration; adjust the printer's duplex offset if it has one.

Deckpress prints these reminders on the calibration page and in the Print jobs
view.

### Duplex alignment

In Print Setup, choose the paper and flip edge you use for the job. In
**Duplex calibration**, start with zero offsets and rotation. Export the
two-page sheet, print it double-sided at 100% with the indicated flip edge,
and hold it to the light with the back facing you. Use the centre target to
estimate how far to move the back crosses to meet the front rings. Compare
the outer targets to see if the back also needs to turn. Positive X moves
right, positive Y moves down, and positive rotation turns clockwise around
the sheet centre after the offsets. Export again to check the correction.

Save the values as a named printer profile and select it on another deck to
copy its correction into that deck. Make separate profiles if paper or feed
settings change alignment. SCM uses the template's paper size and long-edge
flip. Calibration adjusts back artwork; it does not move cutter marks.

## Silhouette Card Maker mode

In Print Setup, choose **Silhouette template (SCM)**, select a card size,
then choose a layout under its paper size. Pick the 3- or 4-mark pattern
for your cutter setup. The picker shows the fixed grid and the exact `.studio3`
filename from SCM's cutting templates, and links to them. SCM does not publish
borderless cut files for A3 or Arch B, so those layouts show a warning and a
link to SCM's borderless docs instead of a filename. The sheet label includes the template
name and version. SCM mode
replaces crop marks with registration marks, caps bleed at **0.625 mm per
side**, and uses long-edge alignment for backs. Switching modes does not
overwrite your bleed or duplex settings. Arch B (12 × 18 in) is a paper
preset in both modes.

### Silhouette Card Maker trim fixture

`packages/core/assets/scm/trim-rects.json` covers all 114 default paper/card
templates at SCM commit `0da09b7`. It excludes borderless variants. Rectangles
are listed row first, with a top-left origin, as `[x, y, width, height]`.

- `exactMm` keeps SCM's chosen grid and centers it on the exact paper size
  using the original card dimensions and a 1.25 mm trim gap, without pixel rounding.
- `scmPx` is the direct output from SCM's `page_manager.generate_layout` at
  300 PPI. `scmMm` is those same pixel values converted to millimeters.
- Grid exclusion uses the default 5 mm registration arm plus 1.5 mm padding
  (6.5 mm), not the per-layout drawn arm length (`drawnArmMm`).

Run from the Deckpress root with Python 3.12+, Git, and the two Python
packages that SCM's page manager imports:

```sh
git clone https://github.com/Alan-Cha/silhouette-card-maker.git ../scm
git -C ../scm checkout --detach 0da09b729814aa5aafde024b5a6059624fa87951
python3 -m venv ../scm-fixture-venv
../scm-fixture-venv/bin/python -m pip install matplotlib==3.11.2 pillow==13.0.0
../scm-fixture-venv/bin/python scripts/generate-scm-fixture.py ../scm
```

The Rust and TypeScript SCM-mode tests compare `scmMm` within 0.02 mm without
specifying rows or columns. The free-mode tests still compare `exactMm` within
0.01 mm using the fixture grids. Free auto-fit does not exclude the registration
corners, so the Rust test still expects an extra column on seven templates.
