const imageOrigin = "https://cards.scryfall.io";
const imageDirectory = "image-cache";

function scryfallImage(source: string) {
  const url = URL.parse(source);
  return url?.origin === imageOrigin ? url : undefined;
}

async function cacheFile(url: URL): Promise<FileSystemFileHandle | undefined> {
  if (!navigator.storage?.getDirectory) return undefined;
  const directory = await navigator.storage.getDirectory();
  const images = await directory.getDirectoryHandle(imageDirectory, {
    create: true,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url.href),
  );
  const key = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const extension = /\.(?:png|jpe?g|webp)$/i.exec(url.pathname)?.[0] ?? "";
  return images.getFileHandle(key + extension, { create: true });
}

export async function clearImageCache() {
  const root = await navigator.storage?.getDirectory?.();
  try {
    await root?.removeEntry(imageDirectory, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError"))
      throw error;
  }
}

export async function downloadImage(url: URL): Promise<Blob> {
  if (url.origin !== imageOrigin) throw new Error("Unsupported image host");
  const handle = await cacheFile(url).catch(() => undefined);
  const file = await handle?.getFile().catch(() => undefined);
  if (file?.size) return file;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error(`Scryfall image returned ${response.status}`);
  const image = await response.blob();
  if (handle) {
    try {
      const writer = await handle.createWritable();
      await writer.write(image);
      await writer.close();
    } catch {
      // The fetched image remains usable when browser storage is unavailable.
    }
  }
  return image;
}

export function imageSrc(source: string): string {
  return scryfallImage(source)?.href ?? "about:blank";
}
