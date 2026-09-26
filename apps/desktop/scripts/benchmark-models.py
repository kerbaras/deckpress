#!/usr/bin/env python3
"""Benchmark the exported ONNX upscalers on a fixed set of Magic cards.

The set covers the frames where upscalers usually fail: dense rules text, a
planeswalker, a saga, a full-art land, a 1993 border and a showcase frame. The
script downloads the Scryfall PNG for each card, runs every model with the same
256 px tiling the Rust pipeline uses, then writes crops of the text box and the
mana cost so the models can be compared where it matters. Judge the crops, not
the art.

With `--fidelity` the script also runs a reference test: each card is
downsampled 4x and re-encoded as JPEG, upscaled back, and compared against the
original with PSNR and SSIM on the same crops. Bicubic resampling is the
baseline every model has to beat.

Usage:
    python benchmark-models.py --models DIR --out DIR [--tile 256] [--overlap 16]
        [--fidelity] [--jpeg-quality 85]

Requires onnxruntime, numpy and Pillow. No PyTorch.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

CARDS = [
    ("text-heavy", "eld", "171"),  # Questing Beast
    ("planeswalker", "war", "221"),  # Teferi, Time Raveler
    ("saga", "dom", "21"),  # History of Benalia
    ("full-art-land", "znr", "280"),  # Forest
    ("old-border", "lea", "161"),  # Lightning Bolt
    ("showcase", "thb", "259"),  # Heliod, Sun-Crowned
]
# Regions in fractions of the card, (left, top, right, bottom).
CROPS = {
    "mana-cost": (0.62, 0.035, 0.96, 0.095),
    "text-box": (0.08, 0.60, 0.92, 0.88),
}
USER_AGENT = "Deckpress/0.1 model benchmark"


def fetch_card(set_code: str, number: str, cache: Path) -> Image.Image:
    path = cache / f"{set_code}-{number}.png"
    if not path.exists():
        request = urllib.request.Request(
            f"https://api.scryfall.com/cards/{set_code}/{number}",
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            card = json.load(response)
        url = (card.get("image_uris") or card["card_faces"][0]["image_uris"])["png"]
        time.sleep(0.2)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:
            path.write_bytes(response.read())
    return Image.open(path).convert("RGB")


def feather(tile: int, overlap: int) -> np.ndarray:
    ramp = np.ones(tile, dtype=np.float32)
    if overlap > 0:
        edge = (np.arange(overlap, dtype=np.float32) + 0.5) / overlap
        ramp[:overlap] = edge
        ramp[-overlap:] = edge[::-1]
    return np.outer(ramp, ramp)


def upscale(
    session: ort.InferenceSession, image: Image.Image, tile: int, overlap: int
) -> tuple[Image.Image, float]:
    """Tile, infer and blend exactly like the Rust pipeline (4x fixed)."""
    scale = 4
    src = np.asarray(image, dtype=np.float32) / 255.0
    h, w, _ = src.shape
    step = tile - overlap
    pad_h = max(0, ((max(h - tile, 0) + step - 1) // step) * step + tile - h)
    pad_w = max(0, ((max(w - tile, 0) + step - 1) // step) * step + tile - w)
    padded = np.pad(src, ((0, pad_h), (0, pad_w), (0, 0)), mode="reflect")
    ph, pw, _ = padded.shape
    out = np.zeros((ph * scale, pw * scale, 3), dtype=np.float32)
    weight = np.zeros((ph * scale, pw * scale, 1), dtype=np.float32)
    window = feather(tile * scale, overlap * scale)[..., None]
    started = time.perf_counter()
    for y in range(0, ph - tile + 1, step):
        for x in range(0, pw - tile + 1, step):
            patch = padded[y : y + tile, x : x + tile].transpose(2, 0, 1)[None]
            result = session.run(None, {"input": np.ascontiguousarray(patch)})[0]
            result = np.clip(result[0].transpose(1, 2, 0), 0, 1)
            oy, ox = y * scale, x * scale
            out[oy : oy + tile * scale, ox : ox + tile * scale] += result * window
            weight[oy : oy + tile * scale, ox : ox + tile * scale] += window
    elapsed = time.perf_counter() - started
    out = out / np.maximum(weight, 1e-6)
    out = out[: h * scale, : w * scale]
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8)), elapsed


def crop(image: Image.Image, box: tuple[float, float, float, float]) -> Image.Image:
    w, h = image.size
    return image.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))


def degrade(image: Image.Image, quality: int) -> Image.Image:
    """Quarter-resolution JPEG, the kind of source a 4x model has to recover from."""
    small = image.resize((image.width // 4, image.height // 4), Image.LANCZOS)
    buffer = io.BytesIO()
    small.save(buffer, format="JPEG", quality=quality)
    buffer.seek(0)
    return Image.open(buffer).convert("RGB")


def gray(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("L"), dtype=np.float64)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a - b) ** 2)
    return float("inf") if mse == 0 else 10 * np.log10(255.0**2 / mse)


def ssim(a: np.ndarray, b: np.ndarray, window: int = 7) -> float:
    """Mean structural similarity over a uniform window (Wang et al. 2004)."""
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2

    def blur(x: np.ndarray) -> np.ndarray:
        pad = window // 2
        padded = np.pad(x, pad, mode="reflect")
        summed = np.cumsum(np.cumsum(padded, axis=0), axis=1)
        summed = np.pad(summed, ((1, 0), (1, 0)))
        h, w = x.shape
        total = (
            summed[window : window + h, window : window + w]
            - summed[:h, window : window + w]
            - summed[window : window + h, :w]
            + summed[:h, :w]
        )
        return total / (window * window)

    mu_a, mu_b = blur(a), blur(b)
    var_a = blur(a * a) - mu_a**2
    var_b = blur(b * b) - mu_b**2
    cov = blur(a * b) - mu_a * mu_b
    score = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / (
        (mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2)
    )
    return float(score.mean())


def fidelity(reference: Image.Image, candidate: Image.Image) -> dict[str, dict[str, float]]:
    if candidate.size != reference.size:
        candidate = candidate.resize(reference.size, Image.BICUBIC)
    scores: dict[str, dict[str, float]] = {}
    for crop_name, box in CROPS.items():
        ref, cand = gray(crop(reference, box)), gray(crop(candidate, box))
        scores[crop_name] = {
            "psnr": round(psnr(ref, cand), 2),
            "ssim": round(ssim(ref, cand), 4),
        }
    return scores


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--tile", type=int, default=256)
    parser.add_argument("--overlap", type=int, default=16)
    parser.add_argument("--only", nargs="*", help="model file names to run")
    parser.add_argument("--fidelity", action="store_true")
    parser.add_argument("--jpeg-quality", type=int, default=85)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    cache = args.out / "cards"
    cache.mkdir(exist_ok=True)
    model_paths = sorted(args.models.glob("*.onnx"))
    if args.only:
        model_paths = [p for p in model_paths if p.name in args.only]
    if not model_paths:
        print("no models found", file=sys.stderr)
        return 1
    options = ort.SessionOptions()
    options.log_severity_level = 3
    sessions = {
        p.name: ort.InferenceSession(str(p), options, providers=["CPUExecutionProvider"])
        for p in model_paths
    }
    report: dict[str, dict[str, float]] = {name: {} for name in sessions}
    quality: dict[str, dict[str, dict[str, dict[str, float]]]] = {}
    for label, set_code, number in CARDS:
        source = fetch_card(set_code, number, cache)
        if args.fidelity:
            reference = source.crop((0, 0, source.width // 4 * 4, source.height // 4 * 4))
            degraded = degrade(reference, args.jpeg_quality)
            bicubic = degraded.resize(reference.size, Image.BICUBIC)
            quality[label] = {"bicubic": fidelity(reference, bicubic)}
            for name, session in sessions.items():
                restored, _ = upscale(session, degraded, args.tile, args.overlap)
                quality[label][name] = fidelity(reference, restored)
                restored.save(args.out / f"fidelity-{label}-{name}.png")
            for name, scores in quality[label].items():
                text, mana = scores["text-box"], scores["mana-cost"]
                print(
                    f"{label:14} {name:45} text {text['psnr']:5.2f} dB / {text['ssim']:.3f}"
                    f"   mana {mana['psnr']:5.2f} dB / {mana['ssim']:.3f}",
                    flush=True,
                )
        rows: list[tuple[str, Image.Image]] = [("source (bicubic 4x)", source.resize(
            (source.width * 4, source.height * 4), Image.BICUBIC))]
        for name, session in sessions.items():
            result, elapsed = upscale(session, source, args.tile, args.overlap)
            report[name][label] = round(elapsed, 2)
            result.save(args.out / f"{label}-{name}.png")
            rows.append((f"{name} ({elapsed:.1f}s)", result))
            print(f"{label:14} {name:45} {elapsed:6.1f}s", flush=True)
        for crop_name, box in CROPS.items():
            crops = [(title, crop(image, box)) for title, image in rows]
            width = max(image.width for _, image in crops)
            height = sum(image.height + 28 for _, image in crops)
            sheet = Image.new("RGB", (width, height), "white")
            draw = ImageDraw.Draw(sheet)
            y = 0
            for title, image in crops:
                draw.text((6, y + 6), title, fill="black")
                sheet.paste(image, (0, y + 28))
                y += image.height + 28
            sheet.save(args.out / f"compare-{label}-{crop_name}.png")
    (args.out / "timings.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    if args.fidelity:
        (args.out / "fidelity.json").write_text(json.dumps(quality, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
