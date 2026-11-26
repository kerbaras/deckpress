import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.DECKPRESS_SKIP_NETWORK === "1") {
  console.log("Skipping model URL checks (DECKPRESS_SKIP_NETWORK=1).");
} else {
  const manifest = new URL(
    "../../../packages/core/models.json",
    import.meta.url,
  );
  const models = JSON.parse(await readFile(manifest, "utf8"));
  const verifySha = process.argv.includes("--verify-sha");
  for (const { id, url, sha256 } of models) {
    if (url === null) continue;
    try {
      const head = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(30_000),
      });
      if (head.status !== 200) throw new Error(`HEAD HTTP ${head.status}`);
      if (verifySha) {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(120_000),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`GET HTTP ${response.status}`);
        }
        const hash = createHash("sha256");
        for await (const chunk of response.body) hash.update(chunk);
        const actual = hash.digest("hex");
        if (actual !== sha256) {
          throw new Error(
            `SHA-256 mismatch: expected ${sha256}, got ${actual}`,
          );
        }
      }
      console.log(
        `${id}: HEAD HTTP 200${verifySha ? ", SHA-256 verified" : ""} (${url})`,
      );
    } catch (error) {
      console.error(`${id}: ${error.message} (${url})`);
      process.exitCode = 1;
    }
  }
}
