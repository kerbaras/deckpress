import { z } from "zod";
import { artSchema } from "../../core/index.ts";
import { checkUploadSize, uploadHash } from "../upload-hash.ts";
import { uploadId } from "./upload-files.ts";
import type { uploadStore } from "./uploads.ts";

const reference = z.object({
  provider: z.literal("upload"),
  imageUrl: z.string(),
  name: z.string(),
  artist: z.string().default("Unknown"),
  bleedMm: z.number().optional(),
  filename: artSchema.shape.filename,
  contentHash: artSchema.shape.contentHash,
});
type BackupUpload = z.infer<typeof reference> & { oracleId: string };
const entries = z.object({
  entries: z
    .array(
      z.object({
        card: z.object({ oracleId: z.string(), faces: z.array(z.unknown()) }),
        selectedArt: z.unknown().optional(),
        selectedBack: z.unknown().optional(),
        policyArt: z.array(z.unknown()).optional(),
      }),
    )
    .default([]),
});

export const missingUploadSchema = reference
  .pick({
    name: true,
    filename: true,
    contentHash: true,
  })
  .extend({ id: z.string() });
export type MissingUpload = z.infer<typeof missingUploadSchema>;
export const uploadAttachmentsSchema = z.array(
  z.object({
    id: z.string(),
    file: z.instanceof(File),
  }),
);
export type UploadAttachment = z.infer<typeof uploadAttachmentsSchema>[number];

export function backupUploads(backup: unknown) {
  const refs = new Map<string, BackupUpload>();
  for (const entry of entries.parse(backup).entries) {
    for (const art of [
      ...entry.card.faces,
      entry.selectedArt,
      entry.selectedBack,
      ...(entry.policyArt ?? []),
    ]) {
      const result = reference.safeParse(art);
      if (!result.success) continue;
      const id = uploadId(result.data.imageUrl);
      if (!id) continue;
      const previous = refs.get(id);
      refs.set(id, {
        ...result.data,
        oracleId: previous?.oracleId ?? entry.card.oracleId,
        name: previous?.name ?? result.data.name,
        artist: previous?.artist ?? result.data.artist,
        bleedMm: previous?.bleedMm ?? result.data.bleedMm,
        filename: previous?.filename ?? result.data.filename,
        contentHash: previous?.contentHash ?? result.data.contentHash,
      });
    }
  }
  return refs;
}

export async function inspectUploads(
  refs: ReturnType<typeof backupUploads>,
  uploads: ReturnType<typeof uploadStore>,
) {
  return Promise.all(
    [...refs].map(async ([id, ref]) => ({
      id,
      ref,
      stored: await uploads.available(id),
    })),
  );
}

export async function prepareReconnection(
  uploads: ReturnType<typeof uploadStore>,
  ref: BackupUpload,
  { id, file }: UploadAttachment,
) {
  checkUploadSize(file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await uploadHash(bytes);
  if (ref.contentHash && ref.contentHash.toLowerCase() !== hash)
    throw new Error(
      `“${file.name}” does not match the original for ${ref.name}.`,
    );
  const { oracleId, name, artist, bleedMm } = ref;
  return uploads.prepare(
    id,
    bytes,
    { oracleId, name, artist, ...(bleedMm !== undefined && { bleedMm }) },
    hash,
    ref.filename ?? file.name,
  );
}
