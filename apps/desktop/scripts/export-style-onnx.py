#!/usr/bin/env python3
"""Exports the art-style embedding model used by "Match art style".

The network is torchvision's ImageNet-pretrained MobileNetV3-Small (BSD-3,
2.5 M parameters) with a Gram-free style head: per-channel mean and standard
deviation of five intermediate feature maps (texture, palette, brushwork) plus
the globally pooled final features (subject matter). Every block is L2
normalised and weighted so that the dot product of two embeddings is a
weighted sum of per-block cosine similarities: 60 % style statistics, 40 %
content. Input is a 1x3x224x224 RGB tensor in 0..1; ImageNet normalisation is
part of the graph. Output is a unit-length 1x1024 vector.

    python export-style-onnx.py --out apps/desktop/src-tauri/models
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import onnx
import torch
import torchvision
from onnxconverter_common import float16

SIZE = 224
STYLE_TAPS = (1, 3, 6, 8, 11)  # 16@56, 24@28, 40@14, 48@14, 96@7 channels
STYLE_WEIGHT = 0.6
CONTENT_WEIGHT = 0.4
EPS = 1e-6


class StyleEmbedder(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        weights = torchvision.models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
        self.features = torchvision.models.mobilenet_v3_small(weights=weights).features
        self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    @staticmethod
    def unit(x: torch.Tensor, weight: float) -> torch.Tensor:
        return x * (weight**0.5 / (x.norm(dim=1, keepdim=True) + EPS))

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        x = (image - self.mean) / self.std
        blocks: list[torch.Tensor] = []
        block_weight = STYLE_WEIGHT / (2 * len(STYLE_TAPS))
        for index, layer in enumerate(self.features):
            x = layer(x)
            if index in STYLE_TAPS:
                flat = x.flatten(2)
                mean = flat.mean(dim=2)
                std = (flat.var(dim=2, unbiased=False) + EPS).sqrt()
                blocks.append(self.unit(mean, block_weight))
                blocks.append(self.unit(std, block_weight))
        blocks.append(self.unit(x.mean(dim=(2, 3)), CONTENT_WEIGHT))
        return torch.cat(blocks, dim=1)


def export(out: Path, keep_fp32: bool) -> Path:
    model = StyleEmbedder().eval()
    with torch.no_grad():
        dims = model(torch.zeros(1, 3, SIZE, SIZE)).shape[1]
    fp32 = out / f"style-mobilenetv3-{SIZE}.fp32.onnx"
    torch.onnx.export(
        model,
        torch.zeros(1, 3, SIZE, SIZE),
        str(fp32),
        input_names=["image"],
        output_names=["embedding"],
        opset_version=17,
        dynamo=False,
        do_constant_folding=True,
    )
    onnx_model = onnx.load(str(fp32))
    onnx.checker.check_model(onnx_model)
    fp16 = float16.convert_float_to_float16(onnx_model, keep_io_types=True)
    path = out / f"style-mobilenetv3-{SIZE}.fp16.onnx"
    onnx.save(fp16, str(path))
    if not keep_fp32:
        fp32.unlink(missing_ok=True)
    print(f"embedding dims: {dims}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "src-tauri" / "models")
    parser.add_argument("--keep-fp32", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    path = export(args.out, args.keep_fp32)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    report_path = args.out / "export-report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    report[path.name] = {"sha256": digest, "bytes": path.stat().st_size}
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"{path.name}\n  sha256 {digest}\n  {path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
