import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crosshair, Download } from "lucide-react";
import { type ReactElement, useState } from "react";
import { api, confirmAction } from "./api.ts";
import type { PrinterProfileInput, PrintSettings } from "./core/index.ts";
import { ErrorNotice, StatusRegion, useTask } from "./ui.tsx";

const fields = [
  {
    key: "backOffsetXmm",
    label: "Back horizontal offset",
    max: 10,
    unit: "mm",
    step: 0.1,
  },
  {
    key: "backOffsetYmm",
    label: "Back vertical offset",
    max: 10,
    unit: "mm",
    step: 0.1,
  },
  {
    key: "backRotationDeg",
    label: "Back rotation",
    max: 180,
    unit: "°",
    step: 0.01,
  },
] as const;
const profileKey = ["printer-profiles"];

function CorrectionInput({
  field: { label, max, unit, step },
  value,
  onChange,
}: {
  field: (typeof fields)[number];
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="setting-row">
      {label}
      <span className="number-unit">
        <input
          type="number"
          value={draft ?? value}
          min={-max}
          max={max}
          step={step}
          onChange={(event) => {
            setDraft(event.target.value);
            const n = event.target.valueAsNumber;
            if (n >= -max && n <= max) onChange(n);
          }}
          onBlur={() => setDraft(null)}
        />
        <span>{unit}</span>
      </span>
    </label>
  );
}

export function DuplexCalibration({
  settings,
  backs,
  onChange,
}: {
  settings: PrintSettings;
  backs: PrintSettings["backs"];
  onChange: (patch: Partial<PrintSettings>) => void;
}) {
  const query = useQuery({
    queryKey: profileKey,
    queryFn: api.printerProfiles,
  });
  const client = useQueryClient();
  const task = useTask();
  const [selectedId, select] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<ReactElement | null>(null);
  const profiles = query.data ?? [];
  const selected = profiles.find((profile) => profile.id === selectedId);
  const flip = backs === "short-edge" ? "short" : "long";
  const corrections = {
    backOffsetXmm: settings.backOffsetXmm,
    backOffsetYmm: settings.backOffsetYmm,
    backRotationDeg: settings.backRotationDeg,
  };
  const saveProfile = (id: string | null) =>
    void task.run(async () => {
      setStatus(null);
      const input: PrinterProfileInput = { name: name.trim(), ...corrections };
      const profile = await api.savePrinterProfile(id, input);
      client.setQueryData<typeof profiles>(profileKey, (previous = []) => [
        profile,
        ...previous.filter((item) => item.id !== profile.id),
      ]);
      select(profile.id);
      setName(profile.name);
      setStatus(
        id === null ? (
          <>Printer profile saved.</>
        ) : (
          <>Printer profile updated.</>
        ),
      );
    });
  const canSave = !task.busy && query.isSuccess && name.trim().length > 0;

  return (
    <section className="panel settings-panel" aria-label="Duplex calibration">
      <div className="section-heading">
        <h3>
          <Crosshair size={14} aria-hidden="true" /> Duplex calibration
        </h3>
      </div>
      <p className="hint">
        View the sheet from the back. Positive offsets move the backs right and
        down; positive rotation turns them clockwise around the sheet centre.
      </p>
      {fields.map((field) => (
        <CorrectionInput
          key={field.key}
          field={field}
          value={corrections[field.key]}
          onChange={(value) => onChange({ [field.key]: value })}
        />
      ))}
      <label className="setting-row">
        Printer profile
        <select
          value={selected?.id ?? ""}
          disabled={task.busy || !query.isSuccess}
          onChange={(event) => {
            const profile = profiles.find(
              (item) => item.id === event.target.value,
            );
            select(profile?.id ?? "");
            setName(profile?.name ?? "");
            setStatus(null);
            if (profile) {
              onChange({
                backOffsetXmm: profile.backOffsetXmm,
                backOffsetYmm: profile.backOffsetYmm,
                backRotationDeg: profile.backRotationDeg,
              });
            }
          }}
        >
          <option value="">Custom correction</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Profile name</span>
        <input
          value={name}
          placeholder="e.g. Home printer · heavy stock"
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="toolbar">
        <button
          type="button"
          disabled={!canSave}
          onClick={() => saveProfile(null)}
        >
          Save new profile
        </button>
        {selected && (
          <>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => saveProfile(selected.id)}
            >
              Update profile
            </button>
            <button
              type="button"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () => {
                  setStatus(null);
                  if (
                    !(await confirmAction(
                      `Delete “${selected.name}”?`,
                      "Delete profile",
                    ))
                  )
                    return;
                  await api.deletePrinterProfile(selected.id);
                  client.setQueryData<typeof profiles>(
                    profileKey,
                    (previous = []) =>
                      previous.filter((item) => item.id !== selected.id),
                  );
                  select("");
                  setName("");
                  setStatus(
                    <>Printer profile deleted. Current correction kept.</>,
                  );
                })
              }
            >
              Delete profile
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        disabled={task.busy}
        onClick={() =>
          void task.run(async () => {
            setStatus(null);
            if (await api.exportDuplexCalibration(settings)) {
              setStatus(<>Duplex calibration sheet saved.</>);
            }
          })
        }
      >
        <Download size={14} aria-hidden="true" /> Export calibration sheet
      </button>
      <p className="hint">
        Start at zero, then export the two-page sheet. Print double-sided at
        100%, flip on the {flip} edge, and hold it up to the light. Adjust until
        the back crosses line up with the front rings, then save your profile.
      </p>
      <StatusRegion
        className={status ? "hint" : "sr-only"}
        label="Duplex calibration status"
      >
        {status}
      </StatusRegion>
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      <ErrorNotice error={task.error} />
    </section>
  );
}
