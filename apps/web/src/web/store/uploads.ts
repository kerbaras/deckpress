import { z } from "zod";
import { artSchema } from "../../core/index.ts";
import type { UploadMetadata } from "../backend/types.ts";
import { uploadHash } from "../upload-hash.ts";
import { uploadProcessing } from "../upload-wasm.ts";
import type { DocumentStore } from "./documents.ts";
import { opfsUploads, uploadId } from "./upload-files.ts";

const kind = "upload";
const uploadSchema = z.object({
  oracleId: z.string(),
  otherOracleIds: z.array(z.string()).optional(),
  art: artSchema,
  bleedAuto: z.boolean(),
});

function parse(json: string) {
  return uploadSchema.parse(JSON.parse(json));
}

export function uploadStore(
  documents: DocumentStore,
  files = opfsUploads(),
  processing = uploadProcessing,
  now = Date.now,
  newId = () => crypto.randomUUID(),
) {
  async function get(id: string) {
    const row = await documents.get(kind, id);
    return row ? parse(row.json) : undefined;
  }

  async function available(id: string) {
    const upload = await get(id);
    return upload && (await files.exists(id)) ? upload : undefined;
  }

  async function find(url: string) {
    const id = uploadId(url);
    const upload = id && (await available(id));
    if (!id || !upload) throw new Error("Uploaded image not found");
    return { id, upload };
  }

  async function edit(
    id: string,
    upload: z.infer<typeof uploadSchema>,
    bleed: number | null,
  ) {
    const file = await files.read(id);
    const next = parse(
      await processing.setBleed(file, JSON.stringify(upload), bleed),
    );
    const art = { ...upload.art, bleedMm: next.art.bleedMm, dpi: next.art.dpi };
    const json = JSON.stringify({ ...upload, art, bleedAuto: next.bleedAuto });
    return { row: { kind, id, json, updatedAt: now() }, art };
  }

  async function prepare(
    id: string,
    bytes: Uint8Array,
    input: UploadMetadata,
    contentHash: string,
    filename?: string,
  ) {
    const updatedAt = now();
    const { metadata, png } = await processing.prepare(
      bytes,
      input,
      id,
      new Date(updatedAt).toISOString(),
    );
    const upload = parse(metadata);
    const art = { ...upload.art, contentHash, ...(filename && { filename }) };
    const json = JSON.stringify({ ...upload, art });
    return { row: { kind, id, json, updatedAt }, art, png };
  }

  return {
    get,
    available,
    edit,
    prepare,
    files,
    async upload(bytes: Uint8Array, input: UploadMetadata, filename?: string) {
      const hash = await uploadHash(bytes);
      for (const row of await documents.list(kind)) {
        const upload = parse(row.json);
        if (upload.art.contentHash !== hash || !(await files.exists(row.id)))
          continue;
        if (
          input.oracleId !== upload.oracleId &&
          !upload.otherOracleIds?.includes(input.oracleId)
        )
          await documents.change(kind, row.id, (current) => {
            const existing = parse((current ?? row).json);
            return {
              ...row,
              json: JSON.stringify({
                ...existing,
                otherOracleIds: [
                  ...new Set([
                    ...(existing.otherOracleIds ?? []),
                    input.oracleId,
                  ]),
                ],
              }),
              updatedAt: now(),
            };
          });
        return upload.art;
      }
      const { row, art, png } = await prepare(
        newId(),
        bytes,
        input,
        hash,
        filename,
      );
      try {
        await files.write(row.id, png);
        await documents.put(row);
      } catch (error) {
        await files.remove(row.id).catch(() => {});
        throw error;
      }
      return art;
    },
    async list(oracleId: string) {
      const matches = await Promise.all(
        (await documents.list(kind)).map(async ({ id, json }) => {
          const upload = parse(json);
          return (upload.oracleId === oracleId ||
            upload.otherOracleIds?.includes(oracleId)) &&
            (await files.exists(id))
            ? upload.art
            : undefined;
        }),
      );
      return matches.filter((art) => art !== undefined);
    },
    async bleed(url: string) {
      const { upload } = await find(url);
      return upload.bleedAuto ? null : upload.art.bleedMm;
    },
    async updateBleed(url: string, bleed: number | null) {
      const { id, upload } = await find(url);
      const { row, art } = await edit(id, upload, bleed);
      await documents.put(row);
      return art;
    },
  };
}
