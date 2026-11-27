import { z } from "zod";
import { artSchema } from "../../core/index.ts";
import type { UploadMetadata } from "../backend/types.ts";
import { uploadProcessing } from "../upload-wasm.ts";
import type { DocumentStore } from "./documents.ts";
import { opfsUploads, uploadId } from "./upload-files.ts";

const kind = "upload";
const uploadSchema = z.object({
  oracleId: z.string(),
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

  async function find(url: string) {
    const id = uploadId(url);
    const upload = id && (await get(id));
    if (!id || !upload) throw new Error("Uploaded image not found");
    return { id, upload };
  }

  async function edit(
    id: string,
    upload: z.infer<typeof uploadSchema>,
    bleed: number | null,
  ) {
    const file = await files.read(id);
    const json = await processing.setBleed(file, JSON.stringify(upload), bleed);
    return { row: { kind, id, json, updatedAt: now() }, art: parse(json).art };
  }

  return {
    get,
    async upload(bytes: Uint8Array, input: UploadMetadata) {
      const id = newId();
      const updatedAt = now();
      const { metadata: json, png } = await processing.prepare(
        bytes,
        input,
        id,
        new Date(updatedAt).toISOString(),
      );
      const { art } = parse(json);
      try {
        await files.write(id, png);
        await documents.put({ kind, id, json, updatedAt });
      } catch (error) {
        await files.remove(id).catch(() => {});
        throw error;
      }
      return art;
    },
    async list(oracleId: string) {
      return (await documents.list(kind))
        .map(({ json }) => parse(json))
        .filter((upload) => upload.oracleId === oracleId)
        .map(({ art }) => art);
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
    async restoreBleeds(bleeds: Map<string, number>) {
      const changes = [];
      for (const [id, bleed] of bleeds) {
        const upload = await get(id);
        if (upload && upload.art.bleedMm !== bleed)
          changes.push(await edit(id, upload, bleed));
      }
      return changes;
    },
  };
}
