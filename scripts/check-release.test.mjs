import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const tag = "v0.1.0";
const version = "0.1.0";
const notes = "\n### Fixed\n\n- Release validation.\n\n";
const changelog = `# Changelog\n\n## ${tag}\n${notes}## v0.0.9\n\nDo not include these notes.\n`;

function fixture(
  t,
  { annotated = true, webVersion = version, notesFile = changelog } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "deckpress-release-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=Release Test", "-c", "user.email=release@example.test", ...args],
      { cwd, stdio: "pipe" },
    );
  const files = {
    "package.json": JSON.stringify({ version }),
    "apps/desktop/package.json": JSON.stringify({ version }),
    "apps/web/package.json": JSON.stringify({ version: webVersion }),
    "apps/desktop/src-tauri/tauri.conf.json": JSON.stringify({ version }),
    "apps/desktop/src-tauri/Cargo.toml": `[package]\nversion = "${version}"\n`,
    "packages/core/Cargo.toml": `[package]\nversion = "${version}"\n`,
    "CHANGELOG.md": notesFile,
  };
  for (const [file, content] of Object.entries(files)) {
    const path = join(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  mkdirSync(join(cwd, "scripts"));
  copyFileSync(
    new URL("./check-release.mjs", import.meta.url),
    join(cwd, "scripts/check-release.mjs"),
  );
  git("init", "--quiet");
  git("add", "--", ...Object.keys(files));
  git("commit", "--quiet", "--no-gpg-sign", "-m", "Release fixture");
  git("tag", ...(annotated ? ["-a", "-m", "Release fixture"] : []), tag);
  return cwd;
}

function validate(cwd) {
  return spawnSync(process.execPath, ["scripts/check-release.mjs", tag], {
    cwd,
    encoding: "utf8",
  });
}

test("accepts an annotated tag with matching versions and emits only its notes", (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, "CHANGELOG.md"), "Uncommitted changes");
  const { status, stdout, stderr } = validate(cwd);
  assert.equal(status, 0, stderr);
  assert.equal(stdout, notes);
});

test("rejects a lightweight tag before producing notes", (t) => {
  const { status, stdout, stderr } = validate(fixture(t, { annotated: false }));
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /Tag v0\.1\.0 must be annotated/);
});

test("rejects a version mismatch even with matching release notes", (t) => {
  const { status, stdout, stderr } = validate(fixture(t, { webVersion: "0.0.9" }));
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /apps\/web\/package\.json has version 0\.0\.9; expected 0\.1\.0 for v0\.1\.0/);
});

test("rejects a missing changelog section", (t) => {
  const { status, stdout, stderr } = validate(fixture(t, { notesFile: "## v0.0.9\n\nOld notes.\n" }));
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /No notes under ## v0\.1\.0 in CHANGELOG\.md/);
});

test("rejects an empty changelog section", (t) => {
  const { status, stdout, stderr } = validate(fixture(t, { notesFile: `## ${tag}\n\n## v0.0.9\nOld notes.\n` }));
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /No notes under ## v0\.1\.0 in CHANGELOG\.md/);
});
