import { type Ref, useState } from "react";
import type { ArtPreview } from "./api.ts";
import {
  type Art,
  type ArtPolicy,
  artBorders,
  artFrames,
  artTreatments,
} from "./core/index.ts";
import { languageCode } from "./print-language.tsx";
import { SetPicker } from "./set-picker.tsx";
import { ArtThumbnail, ErrorNotice, Modal, StatusRegion } from "./ui.tsx";

export function ArtPolicyFields({
  deckId,
  revision,
  current,
  disabled,
  busy,
  previewButton,
  canUndo,
  onPreview,
  onUndo,
}: {
  deckId: string;
  revision: number;
  current: ArtPolicy | undefined;
  disabled: boolean;
  busy: boolean;
  previewButton: Ref<HTMLButtonElement>;
  canUndo: boolean;
  onPreview: (policy: ArtPolicy) => void;
  onUndo: () => void;
}) {
  const [kind, setKind] = useState<ArtPolicy["kind"]>(
    current?.kind ?? "original",
  );
  const [set, setSet] = useState(
    current?.kind === "matchSet" ? current.set : "",
  );
  const [exact, setExact] = useState(
    current?.kind === "matchSet" && current.family !== true,
  );
  const [frame, setFrame] = useState<(typeof artFrames)[number] | "">(
    current?.kind === "style" ? (current.frame ?? "") : "",
  );
  const [border, setBorder] = useState<(typeof artBorders)[number] | "">(
    current?.kind === "style" ? (current.border ?? "") : "",
  );
  const [treatment, setTreatment] = useState<
    (typeof artTreatments)[number] | ""
  >(current?.kind === "style" ? (current.treatment ?? "") : "");
  const policy: ArtPolicy =
    kind === "matchSet"
      ? {
          kind,
          set: set.trim().toLowerCase(),
          family: !exact,
        }
      : kind === "style"
        ? {
            kind,
            frame: frame || null,
            border: border || null,
            treatment: treatment || null,
          }
        : { kind };
  return (
    <fieldset className="field">
      <legend>Deck art policy</legend>
      <p className="hint">
        Apply a print preference across the deck without replacing pinned art.
      </p>
      <label className="field">
        Policy
        <select
          value={kind}
          disabled={busy}
          onChange={(event) => setKind(event.target.value as ArtPolicy["kind"])}
        >
          <option value="original">Original printing</option>
          <option value="latest">Latest printing</option>
          <option value="matchSet">Match set</option>
          <option value="style">Frame, border, or treatment</option>
        </select>
      </label>
      {kind === "matchSet" && (
        <>
          <SetPicker
            deckId={deckId}
            revision={revision}
            value={set}
            disabled={busy}
            onChange={setSet}
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={exact}
              disabled={busy}
              onChange={(event) => setExact(event.target.checked)}
            />
            Only this exact set
          </label>
        </>
      )}
      {kind === "style" && (
        <>
          <label className="field">
            Frame
            <select
              value={frame}
              disabled={busy}
              onChange={(event) => setFrame(event.target.value as typeof frame)}
            >
              <option value="">Any frame</option>
              {artFrames.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Border
            <select
              value={border}
              disabled={busy}
              onChange={(event) =>
                setBorder(event.target.value as typeof border)
              }
            >
              <option value="">Any border</option>
              {artBorders.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Preferred treatment
            <select
              value={treatment}
              disabled={busy}
              onChange={(event) =>
                setTreatment(event.target.value as typeof treatment)
              }
            >
              <option value="">Any treatment</option>
              <option value={artTreatments[0]}>None</option>
              <option value={artTreatments[1]}>Full art</option>
              <option value={artTreatments[2]}>Showcase</option>
            </select>
          </label>
        </>
      )}
      {disabled && (
        <p className="hint">
          Save your deck changes before previewing or undoing art changes.
        </p>
      )}
      <div className="modal-actions">
        {canUndo && (
          <button type="button" disabled={disabled} onClick={onUndo}>
            Undo last art change
          </button>
        )}
        <button
          ref={previewButton}
          type="button"
          aria-disabled={busy}
          disabled={
            disabled ||
            (kind === "matchSet" && !set.trim()) ||
            (kind === "style" && !frame && !border && !treatment)
          }
          onClick={() => {
            if (!busy) onPreview(policy);
          }}
        >
          Preview art policy
        </button>
      </div>
    </fieldset>
  );
}

const labels = {
  changed: "Changed",
  unchanged: "Unchanged",
  pinned: "Pinned — unchanged",
  unmatched: "Unmatched — unchanged",
  fallback: "English fallback",
};

export function PrintSummary({
  art,
  back,
  label,
}: {
  art: Art;
  back?: Art | undefined;
  label: string;
}) {
  return (
    <div className="art-change-print">
      <ArtThumbnail art={art} name="" />
      {back && <ArtThumbnail art={back} name="" />}
      <div>
        <span className="hint">{label}</span>
        <div>
          {art.set.toUpperCase() || art.source}{" "}
          {art.collectorNumber && `#${art.collectorNumber}`} ·{" "}
          {art.language ? languageCode(art.language) : "Language unknown"}
        </div>
      </div>
    </div>
  );
}

export function ArtPreviewDialog({
  preview,
  busy,
  error,
  onKeep,
  onApply,
}: {
  preview: ArtPreview | undefined;
  busy: boolean;
  error: unknown;
  onKeep: () => void;
  onApply: () => void;
}) {
  const kept = preview?.changes.filter(
    ({ kind }) => kind === "unmatched" || kind === "pinned",
  );
  return (
    <Modal title="Preview art changes" wide busy={busy} onClose={onKeep}>
      <p>
        Review the proposed printings. Your deck changes only if you apply this
        preview.
      </p>
      <StatusRegion className="hint" label="Art preview status">
        {!preview && !error && "Finding matching printings on Scryfall…"}
      </StatusRegion>
      {preview && kept && (
        <>
          <p>
            <strong>
              {preview.changes.length - kept.length} matched, {kept.length} kept
              current art
            </strong>
          </p>
          {kept.length > 0 && (
            <ul aria-label="Cards that kept current art">
              {kept.map(({ entryId, name }) => (
                <li key={entryId}>{name}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {preview && (
        <ul className="art-change-list" aria-label="Proposed print changes">
          {preview.changes.map((row) => (
            <li key={row.entryId}>
              <strong>
                {row.quantity}× {row.name}
              </strong>
              <p>
                <span className="badge">{labels[row.kind]}</span> {row.reason}
              </p>
              <div className="art-change-prints">
                <PrintSummary art={row.before} label="Current" />
                {row.after && <PrintSummary art={row.after} label="Proposed" />}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={error} />
      <div className="modal-actions">
        <button
          type="button"
          className="primary"
          onClick={onKeep}
          disabled={busy}
        >
          Keep current choices
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={busy || !preview?.canApply}
        >
          Apply art changes
        </button>
      </div>
    </Modal>
  );
}
