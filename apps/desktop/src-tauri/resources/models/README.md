# Upscaling models

All weights come from [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)
(BSD-3-Clause). They are exported to ONNX with a static `1x3x256x256` input,
opset 17, then converted to FP16 with `onnxconverter-common` while keeping
FP32 inputs and outputs. `models.json` is the manifest the app compiles in:
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
