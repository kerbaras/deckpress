import {
  type ArtPreference,
  artPreferenceSchema,
  artSchema,
  type Deck,
  deckSchema,
  entrySchema,
  healthResponseSchema,
  jobSchema,
  type PrintSettings,
} from "@deckpress/core";
import { z } from "zod";

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(
      error.success ? error.data.error : `Request failed (${response.status})`,
    );
  }
  return schema.parse(data);
}

const json = (method: string, value: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
const okSchema = z.object({ ok: z.boolean() });
export const settingsSchema = z.object({
  upscaler: z.object({
    available: z.boolean(),
    model: z.string(),
    scale: z.number(),
    reason: z.string(),
  }),
  storage: z.string(),
  localOnly: z.boolean(),
});
export const preferencesSchema = z.object({
  preferences: z.record(z.string(), artPreferenceSchema),
  usage: z.record(z.string(), z.number()),
});
const artPageSchema = z.object({
  items: z.array(artSchema),
  page: z.number(),
  hasMore: z.boolean(),
  total: z.number(),
});
const importSchema = z.object({
  entries: z.array(entrySchema),
  issues: z.array(
    z.object({ line: z.number(), input: z.string(), message: z.string() }),
  ),
  format: z.string(),
});
export type ImportResult = z.infer<typeof importSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;

export const api = {
  decks: (signal: AbortSignal) =>
    request("/decks", z.array(deckSchema), { signal }),
  deck: (id: string, signal: AbortSignal) =>
    request(`/decks/${id}`, deckSchema, { signal }),
  createDeck: (
    value: Pick<Deck, "name" | "format"> &
      Partial<
        Pick<Deck, "entries" | "notes" | "printSettings" | "coverEntryId">
      >,
  ) => request("/decks", deckSchema, json("POST", value)),
  saveDeck: (deck: Deck) =>
    request(`/decks/${deck.id}`, deckSchema, json("PUT", deck)),
  deleteDeck: (id: string) =>
    request(`/decks/${id}`, okSchema, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    }),
  import: (value: { text: string } | { url: string }) =>
    request("/import", importSchema, json("POST", value)),
  settings: (signal: AbortSignal) =>
    request("/settings", settingsSchema, { signal }),
  preferences: (signal: AbortSignal) =>
    request("/preferences", preferencesSchema, { signal }),
  savePreference: (id: string, value: ArtPreference) =>
    request(
      `/preferences/${encodeURIComponent(id)}`,
      artPreferenceSchema,
      json("PUT", value),
    ),
  art: (
    provider: "scryfall" | "mpc",
    oracleId: string,
    name: string,
    face: number,
    page: number,
    signal: AbortSignal,
  ) =>
    request(
      `/art?${new URLSearchParams({ provider, oracleId, name, face: String(face), page: String(page) })}`,
      artPageSchema,
      { signal },
    ),
  uploads: (oracleId: string, signal: AbortSignal) =>
    request(`/uploads?oracleId=${oracleId}`, z.array(artSchema), { signal }),
  upload: (data: FormData) =>
    request("/uploads", artSchema, { method: "POST", body: data }),
  jobs: (signal: AbortSignal) =>
    request("/jobs", z.array(jobSchema), { signal }),
  createJob: (deckId: string, settings: PrintSettings) =>
    request("/jobs", jobSchema, json("POST", { deckId, settings })),
  cancelJob: (id: string) =>
    request(`/jobs/${id}/cancel`, okSchema, json("POST", {})),
};

export const fetchHealth = (signal: AbortSignal) =>
  request("/health", healthResponseSchema, { signal });
export function imageSrc(url: string): string {
  return /^\/api\/uploads\/[\da-f-]{36}$/.test(url)
    ? url
    : `/api/image?url=${encodeURIComponent(url)}`;
}
export function downloadJson(deck: Deck) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(deck, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${deck.name.replace(/[^\w-]+/g, "-")}.deckpress.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
