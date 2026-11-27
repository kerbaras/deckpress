import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.ts";
import { ErrorNotice, StatusRegion, useTask } from "../ui.tsx";

function storageSize(bytes: number) {
  return bytes.toLocaleString(undefined, {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  });
}

export function WebStorage({ onCleared }: { onCleared: () => void }) {
  const usage = useQuery({
    queryKey: ["web-storage-usage"],
    queryFn: api.webStorageUsage,
    staleTime: 0,
  });
  const task = useTask();
  const [cleared, setCleared] = useState(false);
  return (
    <section className="panel settings-card">
      <h2>Browser storage</h2>
      <p>
        {usage.data?.usage != null
          ? `Estimated usage: ${storageSize(usage.data.usage / 1_000_000)}${usage.data.quota == null ? "" : ` of ${storageSize(usage.data.quota / 1_000_000)} available`}.`
          : usage.isPending
            ? "Checking browser storage…"
            : "Storage estimates are unavailable in this browser."}
      </p>
      <p>
        Clear downloaded models, card scans, and cached Scryfall data. Your
        decks, uploaded art, preferences, and offline app files stay in this
        browser.
      </p>
      <p className="hint">
        Deck backups reference uploads already in this browser; they do not
        contain image files. Backups with MPC art require the desktop app.
      </p>
      <div className="toolbar">
        <button
          type="button"
          disabled={task.busy}
          onClick={() =>
            void task.run(async () => {
              setCleared(false);
              await api.clearWebCache();
              await usage.refetch();
              onCleared();
              setCleared(true);
            })
          }
        >
          {task.busy ? "Clearing cache…" : "Clear cache"}
        </button>
        <button
          type="button"
          disabled={task.busy || usage.isFetching}
          onClick={() => void usage.refetch()}
        >
          Refresh usage
        </button>
      </div>
      <StatusRegion label="Cache status">
        {cleared ? "Cache cleared." : ""}
      </StatusRegion>
      <ErrorNotice error={task.error ?? usage.error} />
    </section>
  );
}
