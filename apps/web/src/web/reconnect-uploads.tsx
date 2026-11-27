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
    hashes,
    assignments,
  };
}

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
  const [selection, setSelection] = useState<
    Awaited<ReturnType<typeof matchFiles>>
  >({ files: [], hashes: new Map(), assignments: new Map() });
  const { files, hashes, assignments } = selection;
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
              missing.flatMap(({ id }) => {
                const file = files[assignments.get(id) ?? -1]?.file;
                return file ? [{ id, file }] : [];
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
              const picked = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (picked.length)
                void task.run(async () =>
                  setSelection(await matchFiles(missing, picked)),
                );
            }}
          />
        </label>
        {missing.map((upload) => (
          <label className="field" key={upload.id}>
            {upload.name} · {upload.filename ?? upload.id}
            <select
              value={assignments.get(upload.id) ?? ""}
              disabled={task.busy}
              onChange={(event) => {
                const next = new Map(assignments);
                if (event.target.value === "") next.delete(upload.id);
                else next.set(upload.id, Number(event.target.value));
                setSelection({ ...selection, assignments: next });
              }}
            >
              <option value="">Leave missing</option>
              {files.map(({ file, key }, index) => (
                <option
                  key={key}
                  value={index}
                  disabled={
                    !!upload.contentHash &&
                    hashes.get(index) !== upload.contentHash.toLowerCase()
                  }
                >
                  {file.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <ErrorNotice error={task.error} />
        <div className="modal-actions">
          <button className="primary" type="submit" disabled={task.busy}>
            {assignments.size
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
