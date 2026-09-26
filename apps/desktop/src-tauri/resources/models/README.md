# Upscaling models

All weights come from [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)
(BSD-3-Clause). They are exported to ONNX with a static `1x3x256x256` input,
opset 17, then converted to FP16 with `onnxconverter-common` while keeping
FP32 inputs and outputs. `packages/core/models.json` is the manifest compiled into `deckpress-core`:
file names, SHA-256 digests, sizes, licenses and, for models that are not
bundled, the download URL.

Reproduce the exports with `apps/desktop/scripts/export-onnx.py` and compare
models on the fixed card set with `apps/desktop/scripts/benchmark-models.py`.

## Benchmark (CPU, 8 threads, 745x1040 Scryfall PNG, seconds per card)

Fixed set: Questing Beast (text-heavy), Teferi, Time Raveler (planeswalker),
History of Benalia (saga), ZNR Forest (full-art land), Alpha Lightning Bolt
(old border), THB Heliod showcase. Judged on text boxes and mana symbols.

| Model                        | FP16 s/card | Text and symbols                                              |
| ---------------------------- | ----------: | ------------------------------------------------------------- |
| realesr-general-x4v3 (dn 0.5) |     ~6.0 | Sharp glyphs, mild ringing on old-border halftone. Default.    |
| realesr-animevideov3         |       ~3.6 | Slightly softer glyphs, keeps halftone texture. Fast option.   |
| RealESRGAN_x4plus            |      ~60.0 | Cleanest edges and symbols, smooths halftone. Quality option.  |

FP32 general-x4v3 runs in ~3.8 s/card on this CPU; FP16 is only faster on
GPU/Neural Engine execution providers, which is where the default model is
meant to run. The FP16 export differs from FP32 by at most 0.0064 (mean
0.0004) on a 0-1 scale.

## Fidelity (`benchmark-models.py --fidelity`)

Each card is downsampled to a quarter of its size, re-encoded as JPEG at
quality 85, upscaled 4x and compared with the original. SSIM of the text box
and the mana cost crop; higher is better, bicubic resize is the baseline.
Absolute numbers are low for the old-border scan because the reference is
itself a noisy halftone print; only the relative order matters.

| Card          | Bicubic       | general-x4v3  | animevideov3  | x4plus        |
| ------------- | ------------: | ------------: | ------------: | ------------: |
| text-heavy    | 0.562 / 0.534 | 0.686 / 0.668 | 0.683 / 0.645 | 0.690 / 0.684 |
| planeswalker  | 0.533 / 0.634 | 0.618 / 0.659 | 0.628 / 0.662 | 0.614 / 0.665 |
| saga          | 0.625 / 0.685 | 0.675 / 0.748 | 0.698 / 0.774 | 0.691 / 0.750 |
| full-art land | 0.384 / 0.720 | 0.404 / 0.722 | 0.402 / 0.715 | 0.406 / 0.760 |
| old border    | 0.146 / 0.251 | 0.161 / 0.301 | 0.167 / 0.284 | 0.167 / 0.274 |
| showcase      | 0.372 / 0.428 | 0.453 / 0.512 | 0.431 / 0.499 | 0.471 / 0.516 |
| mean          | 0.437 / 0.542 | 0.499 / 0.602 | 0.502 / 0.596 | 0.506 / 0.608 |

Takeaways:

- Every model beats bicubic on text and symbols by a clear margin; the three
  models are within 0.01 SSIM of each other on average, so the 10x cost of
  x4plus buys little on printed text.
- x4plus wins on showcase and full-art frames (painterly art, ornate symbols)
  and is the only one that fully flattens the halftone of old-border scans,
  which reads as clean at 800 DPI but loses the paper texture.
- general-x4v3 (dn 0.5) turns old-border halftone into a woven artefact and
  is the weakest on that card; animevideov3 preserves the dot pattern.
- PSNR tracks SSIM but is flat (18-20 dB for all candidates), so it is not a
  useful discriminator here. Visual crops are written next to `fidelity.json`
  as `compare-<card>-<region>.png`.
