import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crosshair, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [status, setStatus] = useState({ text: "", id: 0 });
  const announcedMissingId = useRef<string | undefined>(undefined);
  const profiles = query.data ?? [];
  const flip = backs === "short-edge" ? "short" : "long";
  const corrections = {
    backOffsetXmm: settings.backOffsetXmm,
    backOffsetYmm: settings.backOffsetYmm,
    backRotationDeg: settings.backRotationDeg,
  };
  const profileToEdit = profiles.find(
    (profile) => profile.id === settings.printerProfileId,
  );
  const selected =
    profileToEdit &&
    fields.every(({ key }) => profileToEdit[key] === corrections[key])
      ? profileToEdit
      : undefined;
  const missingId =
    query.isSuccess && !profileToEdit ? settings.printerProfileId : undefined;
  useEffect(() => {
    if (missingId && missingId !== announcedMissingId.current)
      setStatus(({ id }) => ({
        text: "Printer profile deleted. Current correction kept.",
        id: id + 1,
      }));
    announcedMissingId.current = missingId;
  }, [missingId]);
  const name = nameDraft ?? profileToEdit?.name ?? "";
  const announce = (text: string) =>
    setStatus(({ id }) => ({ text, id: text ? id + 1 : id }));
  const saveProfile = (id: string | null) =>
    void task.run(async () => {
      announce("");
      const input: PrinterProfileInput = { name: name.trim(), ...corrections };
      const profile = await api.savePrinterProfile(id, input);
      client.setQueryData<typeof profiles>(profileKey, (previous = []) => [
        profile,
        ...previous.filter((item) => item.id !== profile.id),
      ]);
      if (id === null) onChange({ printerProfileId: profile.id });
      setNameDraft(null);
      announce(
        id === null ? "Printer profile saved." : "Printer profile updated.",
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
            setNameDraft(null);
            announce("");
            if (!profile) {
              onChange({ printerProfileId: undefined });
              return;
            }
            onChange({
              printerProfileId: profile.id,
              backOffsetXmm: profile.backOffsetXmm,
              backOffsetYmm: profile.backOffsetYmm,
              backRotationDeg: profile.backRotationDeg,
            });
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
          onChange={(event) => setNameDraft(event.target.value)}
        />
      </label>
      <div className="toolbar">
        <button
          type="button"
          disabled={!canSave}
          onClick={() => saveProfile(null)}
        >
          Save as profile
        </button>
        {profileToEdit && (
          <>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => saveProfile(profileToEdit.id)}
            >
              Update profile
            </button>
            <button
              type="button"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () => {
                  announce("");
                  if (
                    !(await confirmAction(
                      `Delete “${profileToEdit.name}”?`,
                      "Delete profile",
                    ))
                  )
                    return;
                  await api.deletePrinterProfile(profileToEdit.id);
                  client.setQueryData<typeof profiles>(
                    profileKey,
                    (previous = []) =>
                      previous.filter((item) => item.id !== profileToEdit.id),
                  );
                  setNameDraft(null);
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
            announce("");
            if (await api.exportDuplexCalibration(settings)) {
              announce("Duplex calibration sheet saved.");
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
        className={status.text ? "hint" : "sr-only"}
        label="Duplex calibration status"
        announcementId={status.id}
      >
        {status.text}
      </StatusRegion>
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      <ErrorNotice error={task.error} />
    </section>
  );
}
