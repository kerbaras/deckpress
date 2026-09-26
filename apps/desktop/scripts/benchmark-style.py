#!/usr/bin/env python3
"""Sanity-checks the style embedding on real card art.

Downloads a few art crops per artist from Scryfall, embeds them with the
exported ONNX model and reports how often the nearest neighbour of each crop
shares its artist (a proxy for "same style"), both for the full embedding and
for its style-only and content-only halves. Random assignment would score
roughly 1/(artists) on this set.

    python benchmark-style.py --model apps/desktop/src-tauri/resources/models/style-mobilenetv3-224.fp16.onnx
"""

from __future__ import annotations

import argparse
import io
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ARTISTS = [
    "Rebecca Guay",
    "Seb McKinnon",
    "John Avon",
    "Terese Nielsen",
    "Kev Walker",
    "Magali Villeneuve",
]
PER_ARTIST = 4
SIZE = 224
STYLE_DIMS = 2 * (16 + 24 + 40 + 48 + 96)
UA = "Deckpress/0.1 (local playtest tool; style benchmark)"


def scryfall(url: str, cache: Path) -> bytes:
    key = cache / urllib.parse.quote(url, safe="")
    if key.exists():
        return key.read_bytes()
    time.sleep(0.6)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})) as response:
        data = response.read()
    key.write_bytes(data)
    return data


def art_crops(artist: str, cache: Path) -> list[tuple[str, bytes]]:
    query = urllib.parse.urlencode({"q": f'a:"{artist}" game:paper -is:digital', "unique": "art", "order": "released"})
    page = json.loads(scryfall(f"https://api.scryfall.com/cards/search?{query}", cache))
    out = []
    for card in page["data"]:
        uris = card.get("image_uris") or (card.get("card_faces") or [{}])[0].get("image_uris")
        if not uris or "art_crop" not in uris:
            continue
        out.append((card["name"], scryfall(uris["art_crop"], cache)))
        if len(out) == PER_ARTIST:
            break
    return out


def preprocess(data: bytes) -> np.ndarray:
    image = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = image.size
    side = min(w, h)
    image = image.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2)).resize((SIZE, SIZE), Image.BICUBIC)
    array = np.asarray(image, dtype=np.float32) / 255.0
    return array.transpose(2, 0, 1)[None]


def unit(x: np.ndarray) -> np.ndarray:
    return x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)


def nearest_accuracy(embeddings: np.ndarray, labels: list[str]) -> float:
    sims = unit(embeddings) @ unit(embeddings).T
    np.fill_diagonal(sims, -1)
    hits = sum(labels[i] == labels[int(np.argmax(sims[i]))] for i in range(len(labels)))
    return hits / len(labels)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path(__file__).resolve().parent / ".style-cache")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    labels, names, vectors = [], [], []
    for artist in ARTISTS:
        for name, data in art_crops(artist, args.cache):
            start = time.perf_counter()
            (embedding,) = session.run(None, {"image": preprocess(data)})
            labels.append(artist)
            names.append(name)
            vectors.append(embedding[0])
            print(f"{artist:18} {name:32} {1000 * (time.perf_counter() - start):5.1f} ms  |e|={np.linalg.norm(embedding):.3f}")
    embeddings = np.stack(vectors)
    print(f"\n{len(labels)} crops, {len(ARTISTS)} artists (chance ≈ {1 / len(ARTISTS):.2f})")
    print(f"nearest-neighbour same artist, full embedding : {nearest_accuracy(embeddings, labels):.2f}")
    print(f"nearest-neighbour same artist, style block    : {nearest_accuracy(embeddings[:, :STYLE_DIMS], labels):.2f}")
    print(f"nearest-neighbour same artist, content block  : {nearest_accuracy(embeddings[:, STYLE_DIMS:], labels):.2f}")


if __name__ == "__main__":
    main()
