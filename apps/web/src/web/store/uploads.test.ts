import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import backup from "../../../../../packages/core/tests/fixtures/deck-backup-before-board-names.json";
import { deckSchema } from "../../core/index.ts";
import type { UploadMetadata } from "../backend/types.ts";
import { deckStore } from "./decks.ts";
import { memoryDocuments } from "./memory.test-helper.ts";
import { opfsUploads, uploadId } from "./upload-files.ts";
import { uploadStore } from "./uploads.ts";

const id = "d04f1cec-448c-4061-a849-5c998e365a4d";
const url = `upload://${id}`;
const legacy = `/api/uploads/${id}`;
const bytes = new Uint8Array([1, 2, 3]);
const oracleId = "oracle";
const contentHash =
  "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

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
    prepare: vi.fn(
      async (_bytes: Uint8Array, input: UploadMetadata, uploadId: string) => ({
        metadata: JSON.stringify({
          oracleId: input.oracleId,
          art: {
            ...art,
            id: `upload:${uploadId}`,
            imageUrl: `upload://${uploadId}`,
            bleedMm: input.bleedMm ?? art.bleedMm,
          },
          bleedAuto: input.bleedMm === undefined,
        }),
        png: bytes,
      }),
    ),
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
  const stored = { ...art, contentHash };
  expect(
    await store().upload(bytes, { oracleId, name: "Upload", artist: "" }),
  ).toEqual(stored);
  expect(getDirectoryHandle).toHaveBeenCalledWith("uploads", { create: true });
  expect([...directory.keys()]).toEqual([`${id}.png`]);
  const file = await opfsUploads(root).read(id);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  expect(getDirectoryHandle).toHaveBeenCalledWith("uploads", { create: false });
  const [row] = await documents.list("upload");
  expect(JSON.parse(row?.json ?? "{}")).toEqual({
    oracleId,
    art: stored,
    bleedAuto: true,
  });
  expect(await store().list(oracleId)).toEqual([stored]);
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
  expect(result.missingUploads).toBe(1);
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

it("includes web upload filenames and hashes in backed-up deck references", async () => {
  const { art, deck, entry, documents, store } = fixture();
  const uploads = store();
  const decks = deckStore(documents, undefined, undefined, uploads);
  const filename = "Art α #1.png";
  await uploads.upload(
    bytes,
    { oracleId, name: "Upload", artist: "" },
    filename,
  );
  entry.selectedArt = art;
  const saved = await decks.create(deck);
  const contents = JSON.stringify(await decks.get(saved.id));
  expect(JSON.parse(contents).entries[0].selectedArt).toEqual({
    ...art,
    filename,
    contentHash,
  });
  const fresh = fixture();
  const freshDecks = deckStore(
    fresh.documents,
    undefined,
    undefined,
    fresh.store(),
  );
  expect(await freshDecks.missingUploads(contents)).toEqual([
    { id, name: art.name, filename, contentHash },
  ]);
});

it("reconnects a legacy upload reference with no filename or hash", async () => {
  const { art, deck, entry, documents, store } = fixture();
  entry.selectedArt = art;
  const contents = JSON.stringify(deck);
  const decks = deckStore(documents, undefined, undefined, store());
  expect(await decks.missingUploads(contents)).toEqual([
    { id, name: art.name },
  ]);
  const file = new File([bytes], "original.jpg");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer,
  });
  expect(await decks.restore(contents, [{ id, file }])).toMatchObject({
    reconnectedUploads: 1,
    missingUploads: 0,
    deck: {
      entries: [
        { selectedArt: { imageUrl: url, filename: file.name, contentHash } },
      ],
    },
  });
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

it("reuses the same ID for renamed originals and lists it for both cards", async () => {
  const { store, processing, directory } = fixture();
  const input = { oracleId, name: "Upload", artist: "" };
  const original = await store().upload(bytes, input, "original.jpg");
  const duplicate = await store().upload(
    bytes,
    { ...input, oracleId: "other" },
    "renamed.jpg",
  );
  expect(duplicate).toEqual(original);
  expect(await store().list("other")).toEqual([original]);
  expect(processing.prepare).toHaveBeenCalledOnce();
  expect(directory.size).toBe(1);
});

it("reconnects under the backup ID and counts metadata with a missing file as unavailable", async () => {
  const { art, deck, entry, documents, directory, store } = fixture();
  const uploads = store();
  await uploads.upload(bytes, { oracleId, name: "Upload", artist: "" });
  directory.delete(`${id}.png`);
  const decks = deckStore(documents, undefined, undefined, uploads);
  entry.selectedArt = {
    ...art,
    bleedMm: 4,
    contentHash,
    filename: "original.jpg",
  };
  const contents = JSON.stringify(deck);
  expect(await decks.missingUploads(contents)).toEqual([
    { id, name: art.name, contentHash, filename: "original.jpg" },
  ]);
  expect(await decks.restore(contents)).toMatchObject({
    updatedUploads: 0,
    missingUploads: 1,
    reconnectedUploads: 0,
  });
  function attachment(data: Uint8Array<ArrayBuffer>) {
    const file = new File([data], "renamed.jpg");
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => data.buffer,
    });
    return { id, file };
  }
  await expect(
    decks.restore(contents, [attachment(new Uint8Array([9]))]),
  ).rejects.toThrow("does not match the original");
  const result = await decks.restore(contents, [attachment(bytes)]);
  expect(result).toMatchObject({
    updatedUploads: 1,
    reconnectedUploads: 1,
    missingUploads: 0,
    deck: {
      entries: [
        {
          selectedArt: {
            imageUrl: url,
            bleedMm: 4,
            filename: "original.jpg",
            contentHash,
          },
        },
      ],
    },
  });
  expect([...directory.keys()]).toEqual([`${id}.png`]);
});
