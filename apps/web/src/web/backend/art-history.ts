import type {
  ArtPreview,
  ArtPreviewProgress,
  PrintLanguagePreferences,
} from "../../api.ts";
import type { ArtPolicy, Deck } from "../../core/index.ts";
import { supportedLanguage } from "../providers/languages.ts";
import type { policyProvider } from "../providers/printings.ts";
import type { deckStore } from "../store/decks.ts";
import { planLocalization, planPolicy, validatePolicy } from "./art-plan.ts";
import { languageOverride, planDeckLanguage } from "./language-plan.ts";
import { canChangeArt } from "./set-matching.ts";

export function artHistory(
  decks: Pick<ReturnType<typeof deckStore>, "get" | "save">,
  provider: ReturnType<typeof policyProvider>,
  preferences: () => Promise<PrintLanguagePreferences>,
) {
  const pending = new Map<
    string,
    { id: string; next: Deck | null; language?: string }
  >();
  const undo = new Map<string, { appliedRevision: number; before: Deck }>();
  let tail = Promise.resolve();

  function serialize<T>(run: () => Promise<T>) {
    const task = tail.then(run);
    tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  async function atRevision(id: string, revision: number) {
    const deck = await decks.get(id);
    if (deck.revision !== revision)
      throw new Error(
        "The deck changed. Reload it before previewing or applying art.",
      );
    return deck;
  }

  async function preview(
    id: string,
    revision: number,
    plan: (
      deck: Deck,
      preferences: PrintLanguagePreferences,
    ) => Promise<{ changes: ArtPreview["changes"]; next: Deck | null }>,
    signal?: AbortSignal,
    language?: string,
  ): Promise<ArtPreview> {
    const { before, previewId } = await serialize(async () => {
      signal?.throwIfAborted();
      const before = await atRevision(id, revision);
      signal?.throwIfAborted();
      const previewId = crypto.randomUUID();
      pending.set(id, { id: previewId, next: null });
      return { before, previewId };
    });
    try {
      const prefs = await preferences();
      signal?.throwIfAborted();
      const { changes, next } = await plan(before, prefs);
      return await serialize(async () => {
        await atRevision(id, revision);
        signal?.throwIfAborted();
        if (pending.get(id)?.id !== previewId)
          throw new Error("This art preview was superseded.");
        pending.set(id, { id: previewId, next, ...(language && { language }) });
        return { previewId, canApply: next !== null, changes, language };
      });
    } catch (error) {
      if (pending.get(id)?.id === previewId) pending.delete(id);
      throw error;
    }
  }

  function languagePending(id: string, previewId: string) {
    const preview = pending.get(id);
    if (preview?.id !== previewId || !preview.language)
      throw new Error(
        "This language preview expired. Preview the changes again.",
      );
    return { preview, language: preview.language };
  }

  return {
    previewPolicy(
      id: string,
      revision: number,
      policy: ArtPolicy,
      signal?: AbortSignal,
    ) {
      validatePolicy(policy);
      return preview(
        id,
        revision,
        (deck, prefs) => planPolicy(provider, deck, policy, prefs, signal),
        signal,
      );
    },
    previewLocalization(
      id: string,
      revision: number,
      entryId: string,
      artId: string,
      signal?: AbortSignal,
    ) {
      return preview(
        id,
        revision,
        (deck, prefs) =>
          planLocalization(provider, deck, entryId, artId, prefs, signal),
        signal,
      );
    },
    previewLanguage(
      id: string,
      revision: number,
      language: string,
      onProgress?: (progress: ArtPreviewProgress) => void,
      signal?: AbortSignal,
    ) {
      if (!supportedLanguage(language))
        throw new Error("Unsupported print language.");
      return preview(
        id,
        revision,
        (deck, prefs) =>
          planDeckLanguage(provider, deck, language, prefs, onProgress, signal),
        signal,
        language,
      );
    },
    async overrideLanguage(
      id: string,
      revision: number,
      previewId: string,
      entryId: string,
      artId: string,
    ) {
      const before = await atRevision(id, revision);
      languagePending(id, previewId);
      const index = before.entries.findIndex((entry) => entry.id === entryId);
      const original = before.entries[index];
      if (!original) throw new Error("Card not found");
      if (!canChangeArt(original)) throw new Error("Manual art is protected.");
      const printing = await provider.get(artId);
      return serialize(async () => {
        await atRevision(id, revision);
        const { preview, language } = languagePending(id, previewId);
        const next = preview.next ?? before;
        const { entry, change } = await languageOverride(
          original,
          next.entries[index] ?? original,
          printing,
          language,
        );
        const entries = next.entries.slice();
        entries[index] = entry;
        preview.next = { ...next, entries };
        return change;
      });
    },
    apply(id: string, revision: number, previewId: string) {
      return serialize(async () => {
        const before = await atRevision(id, revision);
        const preview = pending.get(id);
        if (preview?.id !== previewId || preview.next?.revision !== revision) {
          throw new Error(
            "This art preview expired. Preview the changes again.",
          );
        }
        const deck = await decks.save(preview.next);
        pending.delete(id);
        undo.set(id, { appliedRevision: deck.revision, before });
        return deck;
      });
    },
    undo(id: string, revision: number) {
      return serialize(async () => {
        await atRevision(id, revision);
        const previous = undo.get(id);
        if (!previous) throw new Error("There is no art change to undo.");
        if (previous.appliedRevision !== revision) {
          throw new Error(
            "The deck changed since applying art. Undo would overwrite those changes.",
          );
        }
        const deck = await decks.save({ ...previous.before, revision });
        undo.delete(id);
        pending.delete(id);
        return deck;
      });
    },
  };
}
