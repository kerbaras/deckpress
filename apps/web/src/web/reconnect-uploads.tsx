import { useState } from "react";
import { formatCount } from "../core/index.ts";
import { ErrorNotice, Modal, useTask } from "../ui.tsx";
import type {
  MissingUpload,
  UploadAttachment,
} from "./store/backup-uploads.ts";
import { checkUploadSize, uploadHash } from "./upload-hash.ts";

async function matchFiles(missing: MissingUpload[], files: File[]) {
  for (const file of files) checkUploadSize(file.size);
  const hashes = new Map<number, string>();
  if (missing.some((upload) => upload.contentHash)) {
    for (const [index, file] of files.entries())
      hashes.set(
        index,
        await uploadHash(new Uint8Array(await file.arrayBuffer())),
      );
  }
  const assignments = new Map<string, number>();
  const used = new Set<number>();
  for (const upload of missing) {
    if (!upload.contentHash) continue;
    for (const [index, hash] of hashes) {
      if (hash !== upload.contentHash.toLowerCase()) continue;
      assignments.set(upload.id, index);
      used.add(index);
      break;
    }
  }
  // A filename is only evidence when the backup has no original hash.
  for (const upload of missing) {
    const filename = upload.filename?.toLowerCase();
    if (!filename || upload.contentHash) continue;
    const refs = missing.filter(
      (item) => !item.contentHash && item.filename?.toLowerCase() === filename,
    );
    const candidates = files.flatMap((file, index) =>
      !used.has(index) && file.name.toLowerCase() === filename ? [index] : [],
    );
    const [index] = candidates;
    if (refs.length === 1 && candidates.length === 1 && index !== undefined) {
      assignments.set(upload.id, index);
      used.add(index);
    }
  }
  return {
    files: files.map((file) => ({ file, key: crypto.randomUUID() })),
    matches: assignments,
  };
}

const emptySelection: Awaited<ReturnType<typeof matchFiles>> = {
  files: [],
  matches: new Map(),
};

export function ReconnectUploads({
  missing,
  onClose,
  onRestore,
}: {
  missing: MissingUpload[];
  onClose: () => void;
  onRestore: (attachments: UploadAttachment[]) => Promise<void>;
}) {
  const task = useTask();
  const [selection, setSelection] = useState(emptySelection);
  const [assignments, setAssignments] = useState(new Map<string, number>());
  const { files, matches } = selection;
  return (
    <Modal
      title="Reconnect uploaded art"
      onClose={onClose}
      busy={task.busy}
      wide
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(() =>
            onRestore(
              missing.flatMap<UploadAttachment>(({ id, contentHash }) => {
                const match = matches.get(id);
                const file = files[match ?? assignments.get(id) ?? -1]?.file;
                if (!file) return [];
                return [
                  {
                    id,
                    file,
                    ...(match === undefined &&
                      contentHash && { allowHashMismatch: true }),
                  },
                ];
              }),
            ),
          );
        }}
      >
        <p>
          {formatCount(missing.length, "upload")} missing. Deck backups don't
          include image files. Select the originals together, then assign any
          files that couldn't be matched automatically.
        </p>
        <label className="field">
          Original image files
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={task.busy}
            onChange={(event) => {
              const input = event.currentTarget;
              const picked = Array.from(input.files ?? []);
              setSelection(emptySelection);
              setAssignments(new Map());
              void task.run(async () => {
                try {
                  setSelection(await matchFiles(missing, picked));
                } catch (error) {
                  input.value = "";
                  throw error;
                }
              });
            }}
          />
        </label>
        {missing.map((upload) => {
          const filename = upload.filename ?? upload.id;
          const label = `${upload.name} · ${filename}`;
          const matched = files[matches.get(upload.id) ?? -1]?.file;
          if (matched)
            return (
              <div className="field" key={upload.id}>
                <span className="truncate" title={filename}>
                  {label}
                </span>
                <span className="truncate" title={matched.name}>
                  Matched to {matched.name}
                </span>
              </div>
            );
          const assigned = assignments.get(upload.id);
          const assignmentId = `reconnect-${upload.id}`;
          return (
            <div className="field" key={upload.id}>
              <label
                className="truncate"
                title={filename}
                htmlFor={assignmentId}
              >
                {label}
              </label>
              <select
                id={assignmentId}
                aria-describedby={
                  upload.contentHash ? `${assignmentId}-status` : undefined
                }
                value={assigned ?? ""}
                disabled={task.busy || !files.length}
                onChange={(event) => {
                  const next = new Map(assignments);
                  if (event.target.value === "") next.delete(upload.id);
                  else next.set(upload.id, Number(event.target.value));
                  setAssignments(next);
                }}
              >
                <option value="">Leave missing</option>
                {files.map(({ file, key }, index) => (
                  <option key={key} value={index} title={file.name}>
                    {file.name}
                  </option>
                ))}
              </select>
              {upload.contentHash && (
                <span
                  id={`${assignmentId}-status`}
                  role="status"
                  className={
                    assigned === undefined ? undefined : "warning-text"
                  }
                >
                  {assigned === undefined
                    ? "No matching file selected"
                    : "This file has different contents from the original. Restoring will use it as a replacement."}
                </span>
              )}
            </div>
          );
        })}
        <ErrorNotice error={task.error} />
        <div className="modal-actions">
          <button className="primary" type="submit" disabled={task.busy}>
            {matches.size || assignments.size
              ? "Restore with selected files"
              : "Restore without files"}
          </button>
          <button type="button" disabled={task.busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
