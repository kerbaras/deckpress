import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../data/upscaler",
);
const release = "20251207-174704";
const builds = {
  darwin: {
    platform: "macos",
    sha256: "277419791281a56eae0c739c70120b974d7267cf7c2de8e86dc09798d4b314db",
  },
  linux: {
    platform: "linux",
    sha256: "a9fab3c770b62f2b7a35d8d6d61eb4e8b3aef79128b665c919d080b85a2292f2",
  },
};
if (process.platform !== "darwin" && process.platform !== "linux")
  throw new Error(
    "Automatic setup supports macOS and Linux. On Windows, configure UPSCALE_BIN and UPSCALE_MODELS manually.",
  );
const build = builds[process.platform];
const models = join(root, "models");
await mkdir(models, { recursive: true });
const download = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
console.info("Downloading the pinned Upscayl engine...");
const archive = await download(
  `https://github.com/upscayl/upscayl-ncnn/releases/download/${release}/upscayl-bin-${release}-${build.platform}.zip`,
);
if (createHash("sha256").update(archive).digest("hex") !== build.sha256)
  throw new Error("Upscayl release checksum mismatch");
const archivePath = join(root, "engine.zip");
await writeFile(archivePath, archive);
const { stdout } = await exec("unzip", ["-Z1", archivePath]);
if (
  stdout
    .split("\n")
    .some((name) => name.startsWith("/") || name.split("/").includes(".."))
)
  throw new Error("Unsafe archive paths");
await exec("unzip", ["-n", "-q", archivePath, "-d", root]);
const files = await readdir(root, { recursive: true });
const binaries = files.filter((path) => /(^|\/)upscayl-bin$/.test(path));
const binary =
  binaries.find((path) =>
    path.includes(process.arch === "arm64" ? "arm64" : "x64"),
  ) ??
  binaries.find((path) => !path.includes("arm64")) ??
  binaries[0];
if (!binary) throw new Error("Engine executable not found in release");
await chmod(join(root, binary), 0o755);
const model = "4x_NMKD-Siax_200k";
const commit = "4b6d2cfa59c7442af115dfc6e50fd8d7d40b96ef";
console.info(
  "Downloading NMKD Siax 4x, pinned to the Upscayl model repository commit...",
);
for (const extension of ["param", "bin"]) {
  const bytes = await download(
    `https://raw.githubusercontent.com/upscayl/custom-models/${commit}/models/${model}.${extension}`,
  );
  await writeFile(join(models, `${model}.${extension}`), bytes);
  console.info(
    `${model}.${extension}: ${bytes.length} bytes, SHA-256 ${createHash("sha256").update(bytes).digest("hex")}`,
  );
}
await writeFile(
  join(root, "config.json"),
  JSON.stringify(
    {
      binary: join(root, binary),
      models,
      model,
      engine: "upscayl",
      scale: 4,
      release,
      modelCommit: commit,
      license: "WTFPL",
      source: "https://openmodeldb.info/models/4x-NMKD-Siax-CX",
    },
    null,
    2,
  ),
);
console.info(`Installed local upscaler at ${root}`);
