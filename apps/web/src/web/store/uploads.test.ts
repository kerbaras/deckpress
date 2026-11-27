import { expect, it, vi } from "vitest";
import backup from "../../../../../packages/core/tests/fixtures/deck-backup-before-board-names.json";
import { deckSchema } from "../../core/index.ts";
import { deckStore } from "./decks.ts";
import { memoryDocuments } from "./memory.test-helper.ts";
import { opfsUploads, uploadId } from "./upload-files.ts";
import { uploadStore } from "./uploads.ts";

const id = "d04f1cec-448c-4061-a849-5c998e365a4d";
const url = `upload://${id}`;
const legacy = `/api/uploads/${id}`;
const bytes = new Uint8Array([1, 2, 3]);
const oracleId = "oracle";

function fixture() {
  const deck = deckSchema.parse(backup);
  const entry = deck.entries[0];
  const face = entry?.card.faces[0];
  if (!entry || !face) throw new Error("Missing backup card");
  const art = {
    ...face,
    id: `upload:${id}`,
    imageUrl: url,
    thumbnailUrl: url,
    provider: "upload" as const,
    bleedMm: 3.048,
  };
  const directory = new Map<string, File>();
  function missing() {
    return new DOMException("File not found", "NotFoundError");
  }
  const getDirectoryHandle = vi.fn(async () => ({
    async getFileHandle(name: string, { create = false } = {}) {
      if (!create && !directory.has(name)) throw missing();
      return {
        async getFile() {
          const file = directory.get(name);
          if (!file) throw missing();
          return file;
        },
        async createWritable() {
          let file: File;
          return {
            async write(bytes: Uint8Array<ArrayBuffer>) {
              file = new File([bytes], name, { type: "image/png" });
            },
            async close() {
              directory.set(name, file);
            },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name: string) {
      directory.delete(name);
    },
  }));
  const root = async () =>
    ({ getDirectoryHandle }) as unknown as FileSystemDirectoryHandle;
  const documents = memoryDocuments();
  const processing = {
    prepare: vi.fn(async () => ({
      metadata: JSON.stringify({ oracleId, art, bleedAuto: true }),
      png: bytes,
    })),
    setBleed: vi.fn(async (_file: File, json: string, bleed: number | null) => {
      const upload = JSON.parse(json);
      return JSON.stringify({
        ...upload,
        art: { ...upload.art, bleedMm: bleed ?? art.bleedMm, dpi: 500 },
        bleedAuto: bleed === null,
      });
    }),
  };
  const store = () =>
    uploadStore(
      documents,
      opfsUploads(root),
      processing,
      () => 0,
      () => id,
    );
  return {
    art,
    deck,
    entry,
    directory,
    documents,
    getDirectoryHandle,
    processing,
    root,
    store,
  };
}

it("persists originals under uploads in OPFS and keeps only metadata in IndexedDB", async () => {
  const { art, documents, directory, getDirectoryHandle, root, store } =
    fixture();
  expect(
    await store().upload(bytes, { oracleId, name: "Upload", artist: "" }),
  ).toEqual(art);
  expect(getDirectoryHandle).toHaveBeenCalledWith("uploads", { create: true });
  expect([...directory.keys()]).toEqual([`${id}.png`]);
  const file = await opfsUploads(root).read(id);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  expect(getDirectoryHandle).toHaveBeenCalledWith("uploads", { create: false });
  const [row] = await documents.list("upload");
  expect(JSON.parse(row?.json ?? "{}")).toEqual({
    oracleId,
    art,
    bleedAuto: true,
  });
  expect(await store().list(oracleId)).toEqual([art]);
  expect(await store().list("different")).toEqual([]);
});

it("updates explicit and automatic bleed without replacing the original", async () => {
  const { directory, store } = fixture();
  await store().upload(bytes, { oracleId, name: "Upload", artist: "" });
  const original = directory.get(`${id}.png`);
  expect(await store().bleed(legacy)).toBeNull();
  expect(await store().updateBleed(legacy, 0)).toMatchObject({
    id: `upload:${id}`,
    bleedMm: 0,
    dpi: 500,
  });
  expect(await store().bleed(url)).toBe(0);
  await store().updateBleed(url, null);
  expect(await store().bleed(url)).toBeNull();
  expect(directory.get(`${id}.png`)).toBe(original);
  expect(uploadId("upload://../image")).toBeUndefined();
  await expect(store().bleed("https://example.com/image")).rejects.toThrow(
    "Uploaded image not found",
  );
});

it("removes the OPFS file if committing its IndexedDB metadata fails", async () => {
  const { directory, documents, store } = fixture();
  vi.spyOn(documents, "put").mockRejectedValueOnce(new Error("Cannot save"));
  await expect(
    store().upload(bytes, { oracleId, name: "Upload", artist: "" }),
  ).rejects.toThrow("Cannot save");
  expect(directory.size).toBe(0);
  expect(await store().list(oracleId)).toEqual([]);
});

it("restores existing upload bleed once per ID and retains missing backup references", async () => {
  const { art, deck, entry, documents, processing, store } = fixture();
  const uploads = store();
  const decks = deckStore(documents, undefined, undefined, uploads);
  await uploads.upload(bytes, { oracleId, name: "Upload", artist: "" });
  entry.card.faces = [{ ...art, imageUrl: legacy, bleedMm: 2 }];
  entry.selectedArt = { ...art, bleedMm: 5 };
  const missing = {
    ...art,
    imageUrl: "upload://82d33966-2b62-4a04-9b74-fc6fa8a15daf",
    bleedMm: 6,
  };
  entry.selectedBack = missing;
  const contents = JSON.stringify(deck);
  const result = await decks.restore(contents);
  expect(result.updatedUploads).toBe(1);
  expect(result.deck.entries[0]).toMatchObject({
    card: { faces: [{ bleedMm: 2, dpi: 500 }] },
    selectedArt: { bleedMm: 2, dpi: 500 },
    selectedBack: missing,
  });
  expect(await uploads.bleed(url)).toBe(2);
  expect(await decks.restore(contents)).toMatchObject({ updatedUploads: 0 });
  expect(processing.setBleed).toHaveBeenCalledTimes(1);
  await uploads.updateBleed(url, 4);
  expect(
    (await decks.get(result.deck.id)).entries[0]?.selectedArt?.bleedMm,
  ).toBe(4);
});

it("does not mistake an omitted backup bleed for explicit zero", async () => {
  const { art, deck, entry, documents, processing, store } = fixture();
  const uploads = store();
  const decks = deckStore(documents, undefined, undefined, uploads);
  await uploads.upload(bytes, { oracleId, name: "Upload", artist: "" });
  const contents = JSON.stringify({
    ...deck,
    entries: [{ ...entry, selectedArt: { ...art, bleedMm: undefined } }],
  });
  const result = await decks.restore(contents);
  expect(result.updatedUploads).toBe(0);
  expect(result.deck.entries[0]?.selectedArt?.bleedMm).toBe(art.bleedMm);
  expect(processing.setBleed).not.toHaveBeenCalled();
});
