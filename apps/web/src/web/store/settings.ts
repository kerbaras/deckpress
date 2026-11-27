import { z } from "zod";
import type { PrintLanguagePreferences } from "../../api.ts";
import {
  type ArtPreference,
  artPreferenceSchema,
  type Deck,
  frontArt,
  printerProfileInputSchema,
  printerProfileSchema,
} from "../../core/index.ts";
import { supportedLanguage } from "../providers/languages.ts";
import { type DocumentStore, document, readDocument } from "./documents.ts";

const printLanguageSchema = z.object({
  languages: z.array(z.string()),
  policy: z.enum(["strict", "fallback-to-english"]),
});
const storedPreference = artPreferenceSchema.extend({ id: z.string() });
const defaultLanguage: PrintLanguagePreferences = {
  languages: ["en"],
  policy: "fallback-to-english",
};

function normalizePreference(value: unknown): ArtPreference {
  const input = z
    .object({
      ...artPreferenceSchema.shape,
      tags: z.array(z.string()).default([]),
    })
    .parse(value);
  const tags = [
    ...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean)),
  ];
  return artPreferenceSchema.parse({ ...input, tags });
}

const settingsKind = "settings";
const printLanguageId = "print-language";
const profileKind = "printer_profile";
const preferenceKind = "preference";

export function settingsStore(
  documents: DocumentStore,
  listDecks: () => Promise<Deck[]>,
) {
  async function printLanguage() {
    const row = await documents.get(settingsKind, printLanguageId);
    return row ? printLanguageSchema.parse(readDocument(row)) : defaultLanguage;
  }

  return {
    printLanguage,
    async settings() {
      return {
        models: [],
        defaultModel: "",
        loaded: null,
        styleModel: null,
        storage: "Local IndexedDB",
        localOnly: true,
        dataDir: "",
        printLanguage: await printLanguage(),
      };
    },
    async savePrintLanguage(input: unknown) {
      const preferences = printLanguageSchema.parse(input);
      const langs = preferences.languages;
      if (
        !langs.length ||
        new Set(langs).size !== langs.length ||
        !langs.every(supportedLanguage)
      ) {
        throw new Error(
          "Choose at least one supported print language, without duplicates.",
        );
      }
      await documents.put(document(settingsKind, printLanguageId, preferences));
      return preferences;
    },
    async saveAppearance(input: unknown) {
      const appearance = z.enum(["system", "light", "dark"]).parse(input);
      await documents.put(document(settingsKind, "appearance", appearance));
      return null;
    },
    async preferences() {
      const [rows, decks] = await Promise.all([
        documents.list(preferenceKind),
        listDecks(),
      ]);
      const usage = new Map<string, number>();
      for (const deck of decks) {
        for (const entry of deck.entries) {
          const id = frontArt(entry).id;
          usage.set(id, (usage.get(id) ?? 0) + entry.quantity);
        }
      }
      return {
        usage: Object.fromEntries(usage),
        preferences: Object.fromEntries(
          rows.map((row) => {
            const { id, ...preference } = storedPreference.parse(
              readDocument(row),
            );
            return [id, preference];
          }),
        ),
      };
    },
    async savePreference(id: string, value: unknown) {
      if (!id || [...id].length > 160) throw new Error("Invalid art id");
      const preference = normalizePreference(value);
      await documents.put(document(preferenceKind, id, { id, ...preference }));
      return preference;
    },
    async profiles() {
      return (await documents.list(profileKind)).map((row) =>
        printerProfileSchema.parse(readDocument(row)),
      );
    },
    async saveProfile(id: string | null, value: unknown) {
      const input = printerProfileInputSchema.parse(value);
      const profile = { ...input, id: id ?? crypto.randomUUID() };
      if (id === null) {
        await documents.put(document(profileKind, profile.id, profile));
      } else {
        await documents.change(profileKind, id, (old) => {
          if (!old) throw new Error("Printer profile not found");
          return document(profileKind, id, profile);
        });
      }
      return profile;
    },
    removeProfile: (id: string) => documents.remove(profileKind, id),
  };
}

export function exportFileName(name: string, suffix: string) {
  const stem = name
    .replace(/[^\p{Alphabetic}\p{Number}]/gu, "-")
    .replace(/^-+|-+$/g, "");
  const encoder = new TextEncoder();
  let bytes = 0;
  let capped = "";
  for (const char of stem) {
    bytes += encoder.encode(char).length;
    if (bytes > 150) break;
    capped += char;
  }
  return (capped.replace(/-+$/, "") || "deck") + suffix;
}
