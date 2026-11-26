# Deckpress print-quality case study and plan

Research only. No deckpress code changed. Date: 2026-11-26. References: deckpress `0859698`, silhouette-card-maker (SCM) `0da09b7` (v3.0.0+5), mtg-proxy HEAD.

## 1. Summary

- **Card geometry is correct.** Deckpress places 63 × 88 mm trims exactly (0.000 mm size error) at every DPI tested. When it is set up like an SCM template, all 114 SCM layouts (6 papers × 19 card sizes) give the same card count as SCM's own cut files, and every card edge lands within 0.25 mm of SCM's cut path (standard MTG: ≤ 0.07 mm).
- **Deckpress cannot be cut on a Silhouette yet.** It draws crosshair targets, not SCM's L-shaped registration marks. There's also no "SCM template" mode, so the user has to type in orientation, grid, 0.625 mm bleed, 0 gap and 0 margin by hand. The defaults (A4 portrait, 1 mm bleed, gap 0) don't match any SCM template.
- **"Bigger cards" has several explanations; none is a scaling bug in the PDF.** In order of likelihood:
  1. The *Poker · 2.5 × 3.5 in* preset is 63.5 × 88.9 mm, 0.5 × 0.9 mm larger than MTG.
  2. With 1 mm bleed instead of 0.625 mm, the card pitch is 65 mm instead of SCM's 64.25 mm. On an A4 4 × 2 sheet, the outer cards then sit 1.125 mm off the SCM cut lines.
  3. Mirrored bleed makes an uncut card look 65 × 90 mm.
  4. Printer or viewer scaling ("fit to page", Epson borderless auto-expand). The PDF has no `PrintScaling=None` hint; the calibration page is the only guard.
- **Quality and languages are the big product gaps.** Scryfall has 54,623 Spanish printings, but only 7,138 (13 %) are high-res scans. For Tarkir: Dragonstorm (TDM) it's 1 high-res out of 386. Deckpress only asks Scryfall for English. Its "quality" upscaler model download returns **HTTP 404**.

## 2. Alignment tests (what was run)

Harness: a throwaway Rust binary (`~/harness`, outside the repo) calls `deckpress_core::pdf::build_pdf` with JSON `PrintSettings` and synthetic cards. PDFs were measured with PyMuPDF in millimetres, then compared with:
- SCM `generate_dxf.py single` cut paths (the source of the `.studio3` templates) for all 114 default layouts;
- SCM `create_pdf.py` output for A4 standard with 3 and 4 registration marks (raster overlay).

Deckpress settings used per layout: the orientation, columns and rows from `layouts.json`, `bleedMm 0.625`, `gapMm 0`, `marginMm 0`, `guides none`. Arch B used custom 304.8 × 457.2 mm because deckpress has no Arch B preset.

| Result | Value |
|---|---|
| Layouts exported | 114/114; card count matches SCM in all |
| Trim size error | 0.000 mm (all) |
| Max edge error vs SCM DXF, standard MTG (A4 / Letter / A3) | 0.070 / 0.064 / 0.050 mm |
| Poker A4 | 0.078 mm |
| Worst layouts | credit A3 0.235, credit legal 0.219, euro_mini 0.20, euro_business 0.20 mm |
| ≤ 0.10 mm / ≤ 0.25 mm | 73 / 114 layouts |

Why the residuals exist: SCM computes positions in whole 300-PPI pixels (63 mm → 744 px = 62.99 mm; the 1.25 mm gap → 15 px = 1.27 mm). That rounding builds up across columns. SCM's cut files and SCM's own PDFs use the same rounded numbers, so a pixel-exact match needs the same 300-PPI rounding, not exact millimetres.

Other SCM details found along the way:
- SCM's grid size comes from `page_manager.generate_layout` with a 6.5 mm exclusion zone (5 mm default arm plus 1.5 mm padding) at 300 PPI. The per-layout arm length (9.4 mm for A4 standard) only sets the size of the drawn mark. Using 9.4 mm in the grid calculation gives 3 columns instead of 4, so a port must copy this exactly.
- SCM's PDF is one full-page 300-PPI raster, which makes its "A4" page 296.93 × 209.97 mm.
- Registration marks measured from SCM output: 1 mm thick, outer edge at 9.5 mm (centreline 10 mm), arms of about 9.8 mm outer length. Pattern 3 is a 5 mm square top-left, an L top-right and an L bottom-left. Pattern 4 is four Ls.
- Corner radius: SCM uses 3 mm except credit (0.125 in) and japanese (1 mm). Deckpress hard-codes 3 mm.
- Duplex: SCM assumes long-edge flip. Deckpress's `duplex_slot` mirrors correctly, but it has no rotation correction; SCM's `offset_pdf.py` and Proxxied both have an angle setting.

Oversized-card experiments (A4, synthetic card with a red trim outline):

| Case | Image placed | Visible face |
|---|---|---|
| Defaults (1 mm bleed) | 65 × 90 mm | 63 × 88 mm |
| Poker preset | 65.5 × 90.9 mm | 63.5 × 88.9 mm (bigger) |
| MPC image, bleed declared 3.048 mm | 65 × 90 mm | MPC 63.5 × 88.9 mm face shrunk 1 % into 63 × 88 mm |
| Upload containing bleed but declared 0 | 65 × 90 mm | Face shrinks to about 57.5 × 80.5 mm; the bleed ends up inside the cut |

Not verified: a physical print or cut. Nothing here proves an Epson feed or Cameo registration works.

Overlay: `overlay_a4_standard.png` (grey = both match, cyan = SCM only, which is just the registration marks and label).

## 3. Upscaling models (CPU, 8 cores)

Test A: a high-res English Scryfall PNG (744 × 1040) is downscaled ×0.5, then each method restores it ×2. Metrics are against the original.

| Method | PSNR full | SSIM full | PSNR text box | SSIM text box | Time |
|---|---|---|---|---|---|
| Bicubic | 23.99 | 0.926 | 22.31 | 0.899 | <0.1 s |
| Lanczos | 24.45 | 0.928 | 22.79 | 0.900 | <0.1 s |
| Real-ESRGAN general x4v3 dn50 (bundled) | 24.50 | 0.909 | 22.49 | 0.889 | 5.0 s |
| Real-ESRGAN animevideov3 (bundled) | 25.41 | 0.917 | 23.51 | 0.894 | 2.2 s |
| RealESRGAN x4plus (quality tier) | not tested: download URL returns 404 | | | | |

Test B: a real Spanish low-res scan (EOC 57, 672 × 936) taken to an 800 DPI trim (1984 × 2772): x4v3 took 10.1 s, anime 5.7 s. Visually (`B_text_compare.png`), x4v3 gives the crispest rules text, mana symbols and accents, anime is close behind, and Lanczos and bicubic are soft.

Takeaway: PSNR and SSIM favour smooth output. The GAN models look sharper but score lower on SSIM, so model choice should come from a printed side-by-side, not metrics alone. Not tested: MLX x4v3 (needs Apple Silicon), 4x-UltraSharp/Nomic-style card-tuned ESRGAN, SwinIR/HAT, waifu2x, Proxxied's paid AI.

## 4. Feature gaps

Sources: SCM, mtg-proxy, Proxxied app and deckbuilder (hands-on), Scryfall API (verified with curl), Moxfield (public API and deck pages return 403 to non-browser clients).

| Area | Deckpress today | Gap / opportunity | Reference |
|---|---|---|---|
| Cutter templates | Crosshair targets | SCM template mode: vendored `layouts.json`, 3/4 L marks, 300-PPI rounding, grid locked to the template, template name on the sheet | SCM, Proxxied (Silhouette 3/4, Siser) |
| Paper / card sizes | 6 papers, 2 card presets | Arch B, ANSI; all 19 SCM card sizes with per-size corner radius | SCM |
| Print safety | Calibration page | Warn when settings don't match any SCM template; bleed limit 0.625 mm in template mode; `PrintScaling=None`; label the Poker preset clearly | Bug analysis above |
| Duplex calibration | Back X/Y offset | Rotation offset, calibration-sheet workflow (offset_pdf grid), per-printer profiles | SCM, Proxxied |
| Languages | English only | Language preference with strict / fallback policy; `/cards/:set/:num/:lang`; `include_multilingual`; show `printed_name`; Spanish Wizards-gallery source (from mtg-proxy) | mtg-proxy, SCM `--prefer_lang`, Proxxied |
| Consistent art | Art picker, style match | Deck-wide "art policy": original set / oldest / newest / same illustration across languages (`illustration_id`); frame (`1993`/`1997`/`2003`/`2015`), border, full-art, showcase, `unique=art`; set-wide lock; highlight cards that break the policy | Scryfall syntax, SCM `prefer_older_sets`, `prefer_set` |
| Image quality | Upscaler if < 95 % of target | Quality score per art (`image_status`, px/mm); prefer `highres_scan`; auto-detect upload bleed; edge-extend bleed option; darken / contrast for inkjets; fix the 404 quality model | Scryfall, Proxxied |
| Tokens / related cards | None | Auto-add tokens and emblems from `all_parts`; DFC backs; meld | Proxxied, SCM `--tokens` |
| Import | Moxfield/Archidekt URL, text formats, Archidekt Discover | MPC XML import/export, `(SET) 123` print syntax round-trip, CubeCobra, MTGA/MTGO export with chosen prints | SCM plugin, Proxxied |
| Export | PDF | Image ZIP, page range, cut-template SVG/DXF export, decklist with chosen prints | Proxxied |
| Deck tools | Builder, Discover | Format legality, curve/colour charts, undo history | Proxxied deckbuilder, Moxfield |
| Model choice | 2 bundled + 1 broken | Per-job model picker with preview crops; add a card-tuned model; optional CoreML/DirectML/CUDA execution providers | Section 3 |

## 5. Plan

**Phase 0: correctness (about 1 week)**
- Re-host or repair `RealESRGAN_x4plus-256.fp16.onnx`, and add a test that checks the manifest URLs return 200.
- Rename the Poker preset to "Poker / MPC 63.5 × 88.9 (not MTG)" and show trim size on the sheet label.
- Set `PrintScaling=None` and duplex-flip viewer preferences in the PDF.
- Add a geometry test in `packages/core/tests/` that compares slot trims against vendored SCM reference positions (this study's harness turned into a fixture). Keep `layout.ts` in step with it.

**Phase 1: SCM template mode (1–2 weeks)**
- Vendor SCM `assets/layouts.json` (MIT licence, keep attribution) into `deckpress-core`.
- Add `PrintSettings.template: Option<{paper, card, variant, registration: 3|4}>`. When it's set, `create_layout` uses SCM's `generate_layout` algorithm (300-PPI rounding, 6.5 mm exclusion zone), bleed ≤ 0.625 mm, gap 0, and draws L marks (1 mm, 10 mm inset, per-layout arm length).
- UI: a "Cutter template" picker that fills in and locks the geometry, a matching `.studio3` filename on the sheet label, and a borderless variant.
- Acceptance: every one of the 114 layouts within 0.02 mm of SCM's DXF; then a physical cut on a Cameo 5 Alpha.

**Phase 2: languages and consistent art (2 weeks)**
- `lang` preference list plus a strict / fallback policy (mtg-proxy's rule: never silently fall back). Search with `include_multilingual`, keep `printed_name`, and show the language on every card.
- Same-art localisation: find the target language with the same `illustration_id`, otherwise mark the card unresolved.
- Deck art policy (original printing / oldest / newest / set / frame / border / full art); bulk apply; list cards that don't fit the policy.
- Spanish official gallery source ported from mtg-proxy for sets where Scryfall's Spanish scans are low-res.

**Phase 3: quality pipeline (1–2 weeks)**
- Quality score per candidate art (scan status, source px/mm at the target DPI, JPEG versus PNG); prefer high-res by default.
- Detect bleed automatically on uploads and MPC images.
- Edge-extend bleed mode (SCM `extend_corners`) next to mirror and solid.
- Optional darken / contrast step for inkjets.
- Model picker with a live 100 % crop preview, and benchmark candidate models on printed text sheets.

**Phase 4: workflow (2 weeks)**
- Auto-add tokens and DFC backs.
- MPC XML import/export.
- Image ZIP and cut-template SVG/DXF export.
- Rotation offset plus a duplex calibration wizard and per-printer profiles.
- Legality, curve and colour panels.

**Risks:** Scryfall rate limits and image licence terms; Moxfield blocks non-browser clients (403), so keep URL import best-effort; GAN models can invent text detail; physical calibration can only be validated on the user's own Epson and Cameo.
