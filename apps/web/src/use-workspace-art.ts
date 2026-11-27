import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ArtPreview, type ArtPreviewProgress, api } from "./api.ts";
import type { ArtPolicy, Deck } from "./core/index.ts";
import { languageList } from "./print-language.tsx";
import { useTask } from "./ui.tsx";

export type RegisterPolicyPreview = (
  preview: { discard: () => void; canDiscard: () => boolean } | null,
) => void;

export function useWorkspaceArt({
  deck,
  dirty,
  isSaving,
  saving,
  metadata,
  registerPolicyPreview,
  writeDeck,
}: {
  deck: Deck;
  dirty: boolean;
  isSaving: boolean;
  saving: RefObject<boolean>;
  metadata: boolean;
  registerPolicyPreview: RegisterPolicyPreview;
  writeDeck: (
    save: () => Promise<Deck>,
    options: { preservePreview: boolean },
  ) => Promise<Deck>;
}) {
  const [artPreview, setArtPreview] = useState<{
    result?: ArtPreview;
    error?: unknown;
    language?: string | undefined;
    progress?: ArtPreviewProgress;
  } | null>(null);
  const [canUndoArt, setCanUndoArt] = useState(false);
  const [undoLanguage, setUndoLanguage] = useState(false);
  const [artStatus, setArtStatus] = useState("");
  const artTask = useTask();
  const previewButton = useRef<HTMLButtonElement>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const restorePreviewFocus = useRef<(() => HTMLElement | null) | null>(null);
  useEffect(() => {
    if (artPreview || isSaving) return;
    const opener = restorePreviewFocus.current?.();
    restorePreviewFocus.current = null;
    if (opener?.isConnected) opener.focus();
  }, [artPreview, isSaving]);
  useEffect(
    () => () => {
      previewRequest.current?.abort();
      previewRequest.current = null;
      registerPolicyPreview(null);
    },
    [registerPolicyPreview],
  );
  const keepArt = useCallback(() => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    registerPolicyPreview(null);
    setArtPreview(null);
  }, [registerPolicyPreview]);
  const previewArt = async (
    request: (
      onProgress: (progress: ArtPreviewProgress) => void,
      signal: AbortSignal,
    ) => Promise<ArtPreview>,
    opener: () => HTMLElement | null,
    language?: string,
  ) => {
    if (dirty || saving.current || previewRequest.current) return;
    const controller = new AbortController();
    previewRequest.current = controller;
    registerPolicyPreview({
      discard: keepArt,
      canDiscard: () => !saving.current,
    });
    restorePreviewFocus.current = opener;
    setArtStatus("");
    setArtPreview({ language });
    try {
      const result = await request(
        (progress) =>
          setArtPreview((current) =>
            previewRequest.current === controller &&
            current &&
            !current.result &&
            !current.error
              ? { ...current, progress }
              : current,
          ),
        controller.signal,
      );
      if (previewRequest.current === controller)
        setArtPreview({ result, language });
    } catch (error) {
      if (previewRequest.current === controller)
        setArtPreview({ error, language });
    }
  };
  const previewPolicy = (policy: ArtPolicy, opener?: HTMLButtonElement) =>
    void previewArt(
      (onProgress, signal) =>
        api.previewArtPolicy(
          deck.id,
          deck.revision,
          policy,
          onProgress,
          signal,
        ),
      () => opener ?? previewButton.current,
    );
  const previewLanguage = (language: string, opener: HTMLSelectElement) =>
    void previewArt(
      (onProgress, signal) =>
        api.previewDeckLanguage(
          deck.id,
          deck.revision,
          language,
          onProgress,
          signal,
        ),
      () => opener,
      language,
    );
  const overrideLanguage = async (entryId: string, artId: string) => {
    const result = artPreview?.result;
    if (!result) return;
    const change = await api.overrideLanguagePrint(
      deck.id,
      deck.revision,
      result.previewId,
      entryId,
      artId,
    );
    setArtPreview((current) =>
      current?.result?.previewId === result.previewId
        ? {
            ...current,
            result: {
              ...result,
              canApply: true,
              changes: result.changes.map((item) =>
                item.entryId === entryId ? change : item,
              ),
            },
          }
        : current,
    );
  };
  const previewLocalization = (
    entryId: string,
    artId: string,
    opener: HTMLButtonElement,
  ) =>
    void previewArt(
      (_, signal) =>
        api.previewArtLocalization(
          deck.id,
          deck.revision,
          entryId,
          artId,
          signal,
        ),
      () => opener,
    );
  const applyArt = () =>
    void artTask.run(async () => {
      const result = artPreview?.result;
      if (!result || dirty) return;
      const language = artPreview.language;
      setArtPreview({ result, language });
      try {
        await writeDeck(
          () => api.applyArtPreview(deck.id, deck.revision, result.previewId),
          { preservePreview: metadata },
        );
      } catch (error) {
        setArtPreview({ result, error, language });
        return;
      }
      setCanUndoArt(true);
      setUndoLanguage(!!language);
      keepArt();
      setArtStatus(
        language
          ? `Deck language set to ${languageList([language])}.`
          : "Art changes applied.",
      );
    });
  const undoArt = () =>
    void artTask.run(async () => {
      if (dirty) return;
      setArtStatus("");
      await writeDeck(() => api.undoArtChange(deck.id, deck.revision), {
        preservePreview: true,
      });
      setCanUndoArt(false);
      setArtStatus(
        undoLanguage ? "Language change undone." : "Art changes undone.",
      );
      setUndoLanguage(false);
    });
  return {
    artPreview,
    artTask,
    canUndoArt,
    undoLanguage,
    artStatus,
    previewButton,
    previewPolicy,
    previewLanguage,
    previewLocalization,
    overrideLanguage,
    keepArt,
    applyArt,
    undoArt,
  };
}
