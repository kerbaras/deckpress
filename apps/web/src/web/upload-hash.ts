export function checkUploadSize(size: number) {
  if (size > 16 * 1024 * 1024) throw new Error("Image exceeds 16 MB");
}

export async function uploadHash(bytes: Uint8Array) {
  checkUploadSize(bytes.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
