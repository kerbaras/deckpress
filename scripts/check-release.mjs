import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const jsonManifests = [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];
const cargoManifests = ["apps/desktop/src-tauri/Cargo.toml", "packages/core/Cargo.toml"];

function git(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readPackageVersion(toml) {
  const section = toml
    .split(/^\[/m)
    .find((part) => /^package\][ \t]*\r?\n/.test(part));
  return section?.match(/^[ \t]*version[ \t]*=[ \t]*["']([^"'\r\n]+)["']/m)?.[1];
}

function checkRelease(tag) {
  if (!tag?.startsWith("v") || tag.length === 1) {
    throw new Error("Usage: node scripts/check-release.mjs <v-prefixed tag>");
  }
  const ref = `refs/tags/${tag}`;
  let type;
  try {
    type = git("cat-file", "-t", ref).trim();
  } catch {
    throw new Error(`Tag ${tag} does not exist locally`);
  }
  if (type !== "tag") {
    throw new Error(`Tag ${tag} must be annotated (git tag -a)`);
  }
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  const readAtTag = (path) => git("show", `${commit}:${path}`);
  const expected = tag.slice(1);
  const versions = [
    ...jsonManifests.map((file) => [file, JSON.parse(readAtTag(file)).version]),
    ...cargoManifests.map((file) => [file, readPackageVersion(readAtTag(file))]),
  ];
  for (const [file, actual] of versions) {
    if (actual !== expected) {
      throw new Error(
        `${file} has version ${actual ?? "(missing)"}; expected ${expected} for ${tag}`,
      );
    }
  }

  const lines = readAtTag("CHANGELOG.md").split(/(?<=\n)/);
  const start = lines.findIndex((line) => line.trimEnd() === `## ${tag}`);
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  const notes = start === -1
    ? ""
    : lines.slice(start + 1, end === -1 ? undefined : end).join("");
  if (!notes.trim()) {
    throw new Error(`No notes under ## ${tag} in CHANGELOG.md`);
  }
  return notes;
}

try {
  process.stdout.write(checkRelease(process.argv[2]));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
