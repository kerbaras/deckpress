import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const ATTEMPTS = 3;
const BASE_DELAY_MS = Number(process.env.CHECK_MODELS_RETRY_DELAY_MS ?? 2_000);

class HttpError extends Error {
  constructor(method, status) {
    super(`${method} HTTP ${status}`);
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

const isRetryable = (error) =>
  !(error instanceof Error) || error.retryable !== false;

async function withRetry(label, check) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await check();
    } catch (error) {
      if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `${label}: ${error.message}; retrying in ${delay} ms (attempt ${attempt + 1}/${ATTEMPTS})`,
      );
      await sleep(delay);
    }
  }
}

async function checkModel(url, sha256, verifySha) {
  const head = await fetch(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(30_000),
  });
  if (head.status !== 200) throw new HttpError("HEAD", head.status);
  if (!verifySha) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new HttpError("GET", response.status);
  }
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== sha256) {
    const error = new Error(
      `SHA-256 mismatch: expected ${sha256}, got ${actual}`,
    );
    error.retryable = false;
    throw error;
  }
}

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
      await withRetry(id, () => checkModel(url, sha256, verifySha));
      console.log(
        `${id}: HEAD HTTP 200${verifySha ? ", SHA-256 verified" : ""} (${url})`,
      );
    } catch (error) {
      console.error(`${id}: ${error.message} (${url})`);
      process.exitCode = 1;
    }
  }
}
