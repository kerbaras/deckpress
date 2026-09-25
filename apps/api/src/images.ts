import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Art, artSchema } from "@deckpress/core";
import sharp from "sharp";
import { z } from "zod";
import { AppError } from "./errors.ts";
import type { Store } from "./store.ts";

export function validateImageUrl(input: string): URL {
  const url = new URL(input);
  const allowed =
    [
      "cards.scryfall.io",
      "drive.google.com",
      "drive.usercontent.google.com",
    ].includes(url.hostname) || url.hostname.endsWith(".googleusercontent.com");
  if (
    url.protocol !== "https:" ||
    !allowed ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new AppError(
      "Only Scryfall and Google Drive image URLs are allowed",
      403,
    );
  return url;
}

export const uploadSchema = z.object({ oracleId: z.uuid(), art: artSchema });

export class Images {
  readonly root: string;
  readonly store: Store;
  private readonly pending = new Map<string, Promise<Buffer>>();

  constructor(root: string, store: Store) {
    this.root = root;
    this.store = store;
  }

  async read(url: string): Promise<Buffer> {
    const upload = /^\/api\/uploads\/([\da-f-]{36})$/.exec(url)?.[1];
    if (upload) {
      if (!this.store.get("upload", z.uuid().parse(upload), uploadSchema))
        throw new AppError("Uploaded image not found", 404);
      return readFile(join(this.root, "uploads", `${upload}.png`));
    }
    validateImageUrl(url);
    const key = createHash("sha256").update(url).digest("hex");
    const path = join(this.root, "images", key);
    try {
      return await readFile(path);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.download(url)
      .then(async (bytes) => {
        await mkdir(join(this.root, "images"), { recursive: true });
        await writeFile(path, bytes);
        return bytes;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private async download(input: string): Promise<Buffer> {
    let url = validateImageUrl(input);
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(45_000),
        headers: { "User-Agent": "Deckpress/0.1", Accept: "image/*" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new AppError(
            "Image provider returned an invalid redirect",
            502,
          );
        url = validateImageUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body)
        throw new AppError(
          `Image download failed (${response.status}). Google Drive may be rate limited; retry later or upload the file.`,
          502,
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 32 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError("Image exceeds 32 MB", 413);
        }
        chunks.push(item.value);
      }
      const buffer = Buffer.concat(chunks);
      try {
        const metadata = await sharp(buffer, {
          limitInputPixels: 50_000_000,
        }).metadata();
        if (!["png", "jpeg", "webp"].includes(metadata.format ?? ""))
          throw new Error("Unsupported image");
      } catch {
        throw new AppError(
          "Provider returned an unsupported image or a Google Drive download page. Download it manually and use Upload art.",
          422,
        );
      }
      return buffer;
    }
    throw new AppError("Too many image redirects", 502);
  }

  async upload(
    bytes: Uint8Array,
    input: { oracleId: string; name: string; artist: string; bleedMm: number },
  ): Promise<Art> {
    if (bytes.byteLength > 16 * 1024 * 1024)
      throw new AppError("Uploads are limited to 16 MB", 413);
    const image = sharp(bytes, { limitInputPixels: 50_000_000 });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? ""))
      throw new AppError("Use PNG, JPEG or WebP", 422);
    const normalized = await image
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
    const id = randomUUID();
    await mkdir(join(this.root, "uploads"), { recursive: true });
    await writeFile(join(this.root, "uploads", `${id}.png`), normalized.data);
    const imageUrl = `/api/uploads/${id}`;
    const art = artSchema.parse({
      id: `upload:${id}`,
      provider: "upload",
      name: input.name,
      artist: input.artist || "My upload",
      source: "My uploads",
      imageUrl,
      thumbnailUrl: imageUrl,
      bleedMm: input.bleedMm,
      dpi: Math.round(
        Math.min(
          normalized.info.width / ((63 + 2 * input.bleedMm) / 25.4),
          normalized.info.height / ((88 + 2 * input.bleedMm) / 25.4),
        ),
      ),
      releasedAt: new Date().toISOString(),
      tags: ["custom"],
    });
    this.store.put(
      "upload",
      id,
      uploadSchema.parse({ oracleId: input.oracleId, art }),
    );
    return art;
  }
}
