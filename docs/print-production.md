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

Deckpress: `packages/core/src/layout.ts` and `packages/core-rs/src/layout.rs`
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
- Check the calibration page's 100 mm ruler with a real ruler before a full
  run; a 1% scale error is 0.9 mm on a card.
- Use the heaviest paper the printer feeds reliably (200–300 gsm card stock)
  or print on plain paper and sleeve with a real card behind it.
- For duplex, print one sheet first and hold it against a light to check
  front/back registration; adjust the printer's duplex offset if it has one.

Deckpress prints these reminders on the calibration page and in the Print jobs
view.
