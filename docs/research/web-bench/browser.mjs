import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { availableParallelism } from "node:os";
import { basename, extname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright";

const exec = promisify(execFile);
const models = [
  "realesr-general-x4v3-dn50-256.fp16.onnx",
  "realesr-animevideov3-256.fp16.onnx",
  "RealESRGAN_x4plus-256.fp16.onnx",
];
const repeats = Number(process.env.REPEATS ?? 5);
const threads = Number(process.env.THREADS ?? availableParallelism());
const backends = (process.env.BACKENDS ?? "webgpu,threaded,single").split(",");
const selected = process.argv.slice(2);
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(threads) || threads < 2 ||
    backends.some((x) => !["webgpu", "threaded", "single"].includes(x)) ||
    selected.some((x) => !models.includes(x))) {
  throw new Error("Set positive REPEATS, THREADS >= 2, valid BACKENDS and optional model filenames");
}

const server = createServer(async (req, res) => {
  const url = req.url;
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" })
      .end('<!doctype html><title>Deckpress tile benchmark</title><link rel="icon" href="data:,">');
    return;
  }
  const contentTypes = { ".mjs": "text/javascript", ".wasm": "application/wasm" };
  let path;
  if (url === "/tile.f32" || models.includes(url.slice(1))) path = basename(url);
  if (/^\/ort\/[\w.-]+\.(?:mjs|wasm)$/.test(url)) path = `node_modules/onnxruntime-web/dist/${basename(url)}`;
  if (path) {
    try {
      const body = await readFile(path);
      res.writeHead(200, { "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream" }).end(body);
      return;
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
    }
  }
  res.writeHead(404).end();
});

async function benchmark(url, model, backend, saveOutput) {
  const browser = await chromium.launch({
    channel: "chrome",
    args: backend === "webgpu" ? ["--enable-unsafe-webgpu", "--enable-webgpu-developer-features"] : [],
  });
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { gpu } = await cdp.send("SystemInfo.getInfo");
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) console.error(message.text());
    });
    await page.goto(url);

    let stopped = false;
    let peakRssKiB = 0;
    const sampling = (async () => {
      while (!stopped) {
        const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
        const pids = processInfo
          .filter(({ type }) => ["browser", "renderer", "gpu"].includes(type.toLowerCase()))
          .map(({ id }) => id);
        const { stdout } = await exec("ps", ["-o", "rss=", "-p", pids.join(",")]);
        const rss = stdout.trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0);
        peakRssKiB = Math.max(peakRssKiB, rss);
        if (!stopped) await delay(100);
      }
    })().then(() => null, (error) => error);

    let result;
    try {
      result = await page.evaluate(async ({ model, backend, threads, repeats }) => {
        const webgpu = backend === "webgpu";
        if (!crossOriginIsolated) throw new Error("COOP/COEP required");
        const tile = new Float32Array(await (await fetch("/tile.f32")).arrayBuffer());
        const start = performance.now();
        const ort = await import(webgpu ? "/ort/ort.webgpu.min.mjs" : "/ort/ort.wasm.min.mjs");
        ort.env.wasm.numThreads = backend === "threaded" ? threads : 1;
        let adapterInfo;
        if (webgpu) {
          const adapter = await navigator.gpu?.requestAdapter();
          if (!adapter || adapter.info.isFallbackAdapter || !adapter.features.has("shader-f16")) {
            throw new Error("A hardware WebGPU adapter with shader-f16 is required");
          }
          ort.env.webgpu.adapter = adapter;
          const { vendor, architecture, device, description, isFallbackAdapter, backend: dawnBackend, type } = adapter.info;
          if (type?.toLowerCase() === "cpu") throw new Error("WebGPU selected a CPU adapter");
          adapterInfo = { vendor, architecture, device, description, isFallbackAdapter, dawnBackend, type };
        }
        const session = await ort.InferenceSession.create(`/${model}`, {
          executionProviders: [webgpu ? "webgpu" : "wasm"],
        });
        const loadMs = performance.now() - start;
        if (webgpu && !(await ort.env.webgpu.device).features.has("shader-f16")) {
          throw new Error("ORT's device did not enable shader-f16");
        }
        const input = new ort.Tensor("float32", tile, [1, 3, 256, 256]);
        let output;
        async function run() {
          output?.dispose();
          const before = performance.now();
          const outputs = await session.run({ [session.inputNames[0]]: input });
          output = outputs[session.outputNames[0]];
          const values = await output.getData();
          const ms = performance.now() - before;
          if (output.type !== "float32" || output.dims.join() !== "1,3,1024,1024" ||
              !values.every(Number.isFinite)) {
            throw new Error(`Unexpected output: ${output.type} [${output.dims}]`);
          }
          return ms;
        }
        const firstMs = await run();
        await run();
        const samplesMs = [];
        for (let i = 0; i < repeats; i++) samplesMs.push(await run());
        window.collect = async (saveOutput) => {
          let gpuDispatches = 0;
          const data = output.data;
          const outputBase64 = saveOutput
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).toBase64()
            : undefined;
          if (webgpu) {
            const proto = GPUComputePassEncoder.prototype;
            const dispatch = proto.dispatchWorkgroups;
            proto.dispatchWorkgroups = function (...args) {
              gpuDispatches++;
              return dispatch.apply(this, args);
            };
            try {
              await run();
            } finally {
              proto.dispatchWorkgroups = dispatch;
            }
            if (!gpuDispatches) throw new Error("No compute workgroups dispatched by WebGPU");
          }
          await session.release();
          return { gpuDispatches, outputBase64 };
        };
        const sorted = [...samplesMs].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        return { ort: ort.env.versions.web, adapterInfo, threads: ort.env.wasm.numThreads,
          hardwareConcurrency: navigator.hardwareConcurrency, loadMs, firstMs, samplesMs, medianMs };
      }, { model, backend, threads, repeats });
    } finally {
      stopped = true;
      const error = await sampling;
      if (error) throw error;
    }
    const { gpuDispatches, outputBase64 } = await page.evaluate((save) => window.collect(save), saveOutput);
    if (!peakRssKiB) throw new Error("No Chrome RSS samples");
    console.log(JSON.stringify({
      chrome: browser.version(), backend, model, ...result, peakRssMiB: peakRssKiB / 1024,
      ...(backend === "webgpu" && { gpu: gpu.devices, glRenderer: gpu.auxAttributes.glRenderer, gpuDispatches }),
    }));
    if (outputBase64) return Buffer.from(outputBase64, "base64");
  } finally {
    await browser.close();
  }
}

function compare(model, gpu, wasm) {
  if (gpu.length !== wasm.length) throw new Error("Output lengths differ");
  let sum = 0;
  let max = 0;
  for (let i = 0; i < gpu.length; i += 4) {
    const delta = Math.abs(gpu.readFloatLE(i) - wasm.readFloatLE(i));
    sum += delta;
    max = Math.max(max, delta);
  }
  console.log(JSON.stringify({ model, values: gpu.length / 4, mad: sum / (gpu.length / 4), maxAbsDiff: max }));
}

await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const model of selected.length ? selected : models) {
    const check = backends.includes("webgpu") && backends.includes("threaded");
    const outputs = {};
    for (const backend of backends) {
      try {
        outputs[backend] = await benchmark(url, model, backend, check && backend !== "single");
      } catch (error) {
        console.error(JSON.stringify({ model, backend, error: String(error) }));
        process.exitCode = 1;
      }
    }
    if (outputs.webgpu && outputs.threaded) compare(model, outputs.webgpu, outputs.threaded);
  }
} finally {
  server.close();
}
