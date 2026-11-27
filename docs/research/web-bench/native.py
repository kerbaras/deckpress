import argparse
import json
import os
import resource
import statistics
import sys
import time
from pathlib import Path

import numpy as np


def prepare():
    from PIL import Image

    with Image.open("card.png") as card:
        x, y = (card.width - 256) // 2, (card.height - 256) // 2
        rgb = np.asarray(card.convert("RGB").crop((x, y, x + 256, y + 256)))
    (rgb.transpose(2, 0, 1).astype("<f4") / 255).tofile("tile.f32")


def benchmark(provider, model, repeats):
    import onnxruntime as ort

    if provider not in ort.get_available_providers():
        raise RuntimeError(f"{provider} unavailable: {ort.get_available_providers()}")

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = os.cpu_count()
    providers = ["CPUExecutionProvider"]
    if provider == "CoreMLExecutionProvider":
        providers.insert(0, (provider, {
            "ModelFormat": "MLProgram",
            "RequireStaticInputShapes": "1",
            "MLComputeUnits": "ALL",
            "SpecializationStrategy": "FastPrediction",
        }))

    tile = np.fromfile("tile.f32", dtype="<f4").reshape(1, 3, 256, 256)
    start = time.perf_counter()
    session = ort.InferenceSession(model, sess_options=opts, providers=providers)
    load = (time.perf_counter() - start) * 1000
    if session.get_providers()[0] != provider:
        raise RuntimeError(f"{provider} not active: {session.get_providers()}")
    session.disable_fallback()
    name = session.get_inputs()[0].name

    def run():
        start = time.perf_counter()
        output, = session.run(None, {name: tile})
        elapsed = (time.perf_counter() - start) * 1000
        if output.shape != (1, 3, 1024, 1024) or not np.isfinite(output).all():
            raise RuntimeError(f"Unexpected output from {model}: {output.shape}")
        return elapsed

    first = run()
    run()
    samples = [run() for _ in range(repeats)]
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    rss_bytes = rss if sys.platform == "darwin" else rss * 1024
    print(json.dumps({
        "ort": ort.__version__, "providers": session.get_providers(),
        "intraOpThreads": opts.intra_op_num_threads, "model": Path(model).name,
        "loadMs": load, "firstMs": first, "medianMs": statistics.median(samples),
        "samplesMs": samples, "peakRssMiB": rss_bytes / 1024**2,
    }))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("prepare")
    bench = subcommands.add_parser("bench")
    bench.add_argument("provider", choices=["CPUExecutionProvider", "CoreMLExecutionProvider"])
    bench.add_argument("model")
    bench.add_argument("repeats", nargs="?", type=int, default=5)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare()
    else:
        if args.repeats < 1:
            parser.error("repeats must be positive")
        benchmark(args.provider, args.model, args.repeats)
