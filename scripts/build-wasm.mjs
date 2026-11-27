import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = "wasm32-unknown-unknown";
const targetDir = resolve(root, process.env.CARGO_TARGET_DIR || "target");

function run(command, args) {
  const { status, error } = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (error) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

run("cargo", ["build", "--locked", "-p", "deckpress-core-wasm", "--release", "--target", target]);
run("wasm-bindgen", [
  "--target", "web",
  "--out-dir", "packages/core-wasm/dist",
  resolve(targetDir, target, "release/deckpress_core_wasm.wasm"),
]);
