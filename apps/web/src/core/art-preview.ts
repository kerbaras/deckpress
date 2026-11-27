import { z } from "zod";
import { artSchema } from "./models.ts";

const languageTierSchema = z.enum([
  "samePrinting",
  "sameSet",
  "sameArt",
  "closest",
  "keptEnglish",
  "keptCurrent",
  "pinned",
  "override",
]);
export const artChangeSchema = z.object({
  entryId: z.uuid(),
  name: z.string(),
  quantity: z.number(),
  before: artSchema,
  after: artSchema.nullable(),
  kind: z.enum(["changed", "unchanged", "pinned", "unmatched", "fallback"]),
  reason: z.string(),
  tier: languageTierSchema.optional(),
  beforeBack: artSchema.optional(),
  afterBack: artSchema.optional(),
});
export const artPreviewSchema = z.object({
  previewId: z.uuid(),
  canApply: z.boolean(),
  changes: z.array(artChangeSchema),
  language: z.string().optional(),
});
export type ArtPreview = z.infer<typeof artPreviewSchema>;
export type ArtChange = z.infer<typeof artChangeSchema>;
export type LanguageTier = z.infer<typeof languageTierSchema>;
