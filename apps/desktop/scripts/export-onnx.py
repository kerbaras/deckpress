#!/usr/bin/env python3
"""Export Real-ESRGAN PyTorch weights to static-shape ONNX for the Deckpress desktop app.

    python3 -m venv venv && ./venv/bin/pip install torch onnx onnxconverter-common
    ./venv/bin/python export-onnx.py --out ../src-tauri/models

Each model is exported with a fixed 1x3xTILExTILE input (default 256) so the Core ML
execution provider keeps the whole graph on the ANE/GPU, then converted to FP16 with
float32 inputs and outputs. The script prints the SHA-256 of every file so the values
can be pinned in `models.json`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import urllib.request
from pathlib import Path

import onnx
import torch
from onnxconverter_common import float16
from torch import nn
from torch.nn import functional as F

RELEASES = "https://github.com/xinntao/Real-ESRGAN/releases/download"


class SRVGGNetCompact(nn.Module):
    """Compact VGG-style network used by realesr-general-x4v3 and realesr-animevideov3."""

    def __init__(self, num_feat: int, num_conv: int, upscale: int) -> None:
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(3, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, 3 * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        base = F.interpolate(x, scale_factor=self.upscale, mode="nearest")
        return out + base


class ResidualDenseBlock(nn.Module):
    def __init__(self, num_feat: int, num_grow_ch: int) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, num_feat: int, num_grow_ch: int) -> None:
        super().__init__()
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.rdb3(self.rdb2(self.rdb1(x)))
        return out * 0.2 + x


class RRDBNet(nn.Module):
    """RealESRGAN_x4plus."""

    def __init__(self, num_feat: int = 64, num_block: int = 23, num_grow_ch: int = 32) -> None:
        super().__init__()
        self.conv_first = nn.Conv2d(3, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, 3, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        feat = self.conv_first(x)
        feat = self.conv_body(self.body(feat)) + feat
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


MODELS = {
    "realesr-general-x4v3": {
        "weights": [f"{RELEASES}/v0.2.5.0/realesr-general-x4v3.pth"],
        "denoise": f"{RELEASES}/v0.2.5.0/realesr-general-wdn-x4v3.pth",
        "build": lambda: SRVGGNetCompact(64, 32, 4),
    },
    "realesr-animevideov3": {
        "weights": [f"{RELEASES}/v0.2.5.0/realesr-animevideov3.pth"],
        "build": lambda: SRVGGNetCompact(64, 16, 4),
    },
    "RealESRGAN_x4plus": {
        "weights": [f"{RELEASES}/v0.1.0/RealESRGAN_x4plus.pth"],
        "build": lambda: RRDBNet(),
    },
}


def fetch(url: str, cache: Path) -> Path:
    path = cache / url.rsplit("/", 1)[1]
    if not path.exists():
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, path)
    return path


def load_state(path: Path) -> dict[str, torch.Tensor]:
    data = torch.load(path, map_location="cpu", weights_only=True)
    return data.get("params_ema", data.get("params", data))


def export(name: str, spec: dict, out: Path, cache: Path, tile: int, denoise: float) -> Path:
    model = spec["build"]()
    state = load_state(fetch(spec["weights"][0], cache))
    suffix = ""
    if "denoise" in spec and denoise > 0:
        wdn = load_state(fetch(spec["denoise"], cache))
        state = {k: v * (1 - denoise) + wdn[k] * denoise for k, v in state.items()}
        suffix = f"-dn{int(round(denoise * 100)):02d}"
    model.load_state_dict(state, strict=True)
    model.eval()
    fp32 = out / f"{name}{suffix}-{tile}.fp32.onnx"
    torch.onnx.export(
        model,
        torch.zeros(1, 3, tile, tile),
        str(fp32),
        input_names=["input"],
        output_names=["output"],
        opset_version=17,
        dynamo=False,
        do_constant_folding=True,
    )
    onnx_model = onnx.load(str(fp32))
    onnx.checker.check_model(onnx_model)
    fp16 = float16.convert_float_to_float16(onnx_model, keep_io_types=True)
    path = out / f"{name}{suffix}-{tile}.fp16.onnx"
    onnx.save(fp16, str(path))
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "src-tauri" / "models")
    parser.add_argument("--cache", type=Path, default=Path(__file__).resolve().parent / ".weights")
    parser.add_argument("--tile", type=int, default=256)
    parser.add_argument("--denoise", type=float, default=0.5, help="realesr-general-x4v3 denoise strength (0-1)")
    parser.add_argument("--only", nargs="*", choices=sorted(MODELS), default=sorted(MODELS))
    parser.add_argument("--keep-fp32", action="store_true")
    args = parser.parse_args()
    if not 0 <= args.denoise <= 1 or not math.isfinite(args.denoise):
        parser.error("--denoise must be between 0 and 1")
    args.out.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    report = {}
    for name in args.only:
        path = export(name, MODELS[name], args.out, args.cache, args.tile, args.denoise)
        if not args.keep_fp32:
            path.with_suffix("").with_suffix(".fp32.onnx").unlink(missing_ok=True)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        report[path.name] = {"sha256": digest, "bytes": path.stat().st_size}
        print(f"{path.name}\n  sha256 {digest}\n  {path.stat().st_size / 1e6:.1f} MB")
    (args.out / "export-report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
