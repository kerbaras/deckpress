import {
  type Art,
  backArt,
  createLayout,
  type Deck,
  duplexSlot,
  frontArt,
  mmToPixels,
  type PrintSettings,
  printableEntries,
  printSettingsSchema,
} from "@deckpress/core";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Download,
  Printer,
  Save,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { ErrorNotice, useTask } from "./ui.tsx";

const paperNames = {
  a4: "A4",
  letter: "US Letter",
  a3: "A3",
  a5: "A5",
  legal: "US Legal",
  tabloid: "Tabloid",
  custom: "Custom",
};

export function PrintSetup({
  deck,
  onChange,
  onSave,
  onJobs,
}: {
  deck: Deck;
  onChange: (deck: Deck) => void;
  onSave: (deck: Deck) => Promise<Deck>;
  onJobs: () => void;
}) {
  const settings = deck.printSettings;
  const system = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.settings(signal),
  });
  const task = useTask();
  const [page, setPage] = useState(0);
  const [back, setBack] = useState(false);
  const [trim, setTrim] = useState(false);
  const [presetMessage, setPresetMessage] = useState("");
  const [previewSettings, setPreviewSettings] = useState(settings);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewSettings(settings), 250);
    return () => clearTimeout(timer);
  }, [settings]);
  const change = (patch: Partial<PrintSettings>) => {
    onChange({ ...deck, printSettings: { ...settings, ...patch } });
    setPage(0);
  };
  let layout: ReturnType<typeof createLayout> | null = null;
  let layoutError: unknown = null;
  try {
    layout = createLayout(settings);
  } catch (error) {
    layoutError = error;
  }
  const entries = printableEntries(deck, settings);
  const cards = entries.flatMap((entry) =>
    Array.from({ length: entry.quantity }, () => entry),
  );
  const totalSheets = layout
    ? Math.ceil(cards.length / layout.slots.length)
    : 0;
  const first = settings.pageFrom - 1;
  const last = settings.pageTo
    ? Math.min(settings.pageTo, totalSheets)
    : totalSheets;
  const selectedSheets = Math.max(0, last - first);
  const valid =
    !!layout &&
    selectedSheets > 0 &&
    (!settings.upscale || system.data?.upscaler.available);
  const currentPage = Math.max(first, Math.min(first + page, last - 1));
  const pageCards = layout
    ? cards.slice(
        currentPage * layout.slots.length,
        (currentPage + 1) * layout.slots.length,
      )
    : [];
  const selectedCards = layout
    ? cards.slice(first * layout.slots.length, last * layout.slots.length)
    : [];
  const arts = [
    ...new Map(
      selectedCards
        .flatMap((entry) => [
          frontArt(entry),
          ...(settings.backs !== "none" && backArt(entry)
            ? [backArt(entry)]
            : []),
        ])
        .filter((art): art is Art => !!art)
        .map((art) => [art.id, art]),
    ).values(),
  ];
  const lowResolution = arts.filter(
    (art) => art.dpi < settings.dpi * 0.95,
  ).length;
  const estimatedMB = arts.length * 0.45 * (settings.dpi / 600) ** 2;
  const start = () =>
    void task.run(async () => {
      const saved = await onSave(deck);
      await api.createJob(saved.id, settings);
      onJobs();
    });
  return (
    <div className="print-workspace">
      <div className="print-title toolbar">
        <div>
          <h2>Print setup</h2>
          <p className="muted">Physical dimensions first. No hidden scaling.</p>
        </div>
        <div className="spacer" />
        <span className="mono muted">
          {selectedSheets} sheets ·{" "}
          {selectedSheets * (settings.backs === "none" ? 1 : 2)} PDF pages
        </span>
        <button
          type="button"
          className="primary"
          disabled={!valid || task.busy}
          onClick={start}
        >
          <Download size={16} />
          {task.busy ? "Queuing…" : "Generate PDF"}
        </button>
      </div>
      <ErrorNotice error={task.error ?? layoutError} />
      <div className="print-layout">
        <div className="print-controls">
          <div className="panel presets">
            <label className="field">
              Print preset
              <select
                aria-label="Print preset"
                defaultValue=""
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  if (value === "saved")
                    void task.run(async () => {
                      const stored = localStorage.getItem(
                        "deckpress.print-preset",
                      );
                      if (!stored) throw new Error("Save a print preset first");
                      change(printSettingsSchema.parse(JSON.parse(stored)));
                    });
                  else
                    change(
                      printSettingsSchema.parse(
                        value === "proof"
                          ? { dpi: 300 }
                          : value === "letter"
                            ? { paper: "letter" }
                            : value === "shop"
                              ? {
                                  paper: "a3",
                                  dpi: 1200,
                                  bleedMm: 3,
                                  gapMm: 2,
                                  marginMm: 6,
                                }
                              : {},
                      ),
                    );
                  event.target.value = "";
                }}
              >
                <option value="">Custom settings</option>
                <option value="home">Home inkjet · A4 / 600 DPI</option>
                <option value="letter">Home inkjet · Letter / 600 DPI</option>
                <option value="proof">Quick proof · A4 / 300 DPI</option>
                <option value="shop">Print shop · A3 / 1200 DPI</option>
                <option value="saved">Your saved preset</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!!layoutError}
              onClick={() =>
                void task.run(async () => {
                  localStorage.setItem(
                    "deckpress.print-preset",
                    JSON.stringify(settings),
                  );
                  setPresetMessage("Preset saved on this browser");
                })
              }
            >
              <Save size={14} />
              Save preset
            </button>
            {presetMessage && (
              <span className="hint" role="status">
                {presetMessage}
              </span>
            )}
          </div>
          <section className="panel settings-panel">
            <h3>Sheet</h3>
            <label className="setting-row">
              Paper size
              <select
                value={settings.paper}
                onChange={(event) =>
                  change({
                    paper: event.target.value as PrintSettings["paper"],
                  })
                }
              >
                {Object.entries(paperNames).map(([key, name]) => (
                  <option value={key} key={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {settings.paper === "custom" && (
              <>
                <NumberSetting
                  label="Sheet width"
                  value={settings.customWidthMm}
                  min={40}
                  max={1000}
                  set={(value) => change({ customWidthMm: value })}
                />
                <NumberSetting
                  label="Sheet height"
                  value={settings.customHeightMm}
                  min={40}
                  max={1000}
                  set={(value) => change({ customHeightMm: value })}
                />
              </>
            )}
            <label className="setting-row">
              Orientation
              <select
                value={settings.orientation}
                onChange={(event) =>
                  change({
                    orientation: event.target
                      .value as PrintSettings["orientation"],
                  })
                }
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <NumberSetting
              label="Printer margin"
              value={settings.marginMm}
              min={0}
              max={50}
              set={(value) => change({ marginMm: value })}
            />
            <p className="hint">
              Check your printer's non-printable margins. The default 4 mm fits
              3 × 3 on A4 and Letter.
            </p>
          </section>
          <section className="panel settings-panel">
            <h3>Cards & layout</h3>
            <label className="setting-row">
              Card size
              <select
                value={`${settings.cardWidthMm}x${settings.cardHeightMm}`}
                onChange={(event) => {
                  if (event.target.value === "custom") return;
                  const [width, height] = event.target.value
                    .split("x")
                    .map(Number);
                  if (width && height)
                    change({ cardWidthMm: width, cardHeightMm: height });
                }}
              >
                <option value="63x88">MTG · 63 × 88 mm</option>
                <option value="63.5x88.9">Poker · 2.5 × 3.5 in</option>
                <option value="59x86">Japanese · 59 × 86 mm</option>
                <option value="89x127">Oversized · 89 × 127 mm</option>
                <option
                  value={`${settings.cardWidthMm}x${settings.cardHeightMm}`}
                  hidden
                >
                  Custom
                </option>
              </select>
            </label>
            <NumberSetting
              label="Card width"
              min={25}
              max={200}
              value={settings.cardWidthMm}
              set={(value) => change({ cardWidthMm: value })}
            />
            <NumberSetting
              label="Card height"
              min={25}
              max={250}
              value={settings.cardHeightMm}
              set={(value) => change({ cardHeightMm: value })}
            />
            <NumberSetting
              label="Gap between bleeds"
              min={0}
              max={20}
              value={settings.gapMm}
              set={(value) => change({ gapMm: value })}
            />
            <NumberSetting
              label="Columns · 0 is auto"
              min={0}
              max={20}
              step={1}
              unit=""
              value={settings.columns}
              set={(value) => change({ columns: value })}
            />
            <NumberSetting
              label="Rows · 0 is auto"
              min={0}
              max={20}
              step={1}
              unit=""
              value={settings.rows}
              set={(value) => change({ rows: value })}
            />
          </section>
          <section className="panel settings-panel">
            <h3>Bleed</h3>
            <NumberSetting
              label="Bleed per side"
              min={0}
              max={5}
              value={settings.bleedMm}
              set={(value) => change({ bleedMm: value })}
            />
            <label className="setting-row">
              Fill
              <select
                value={settings.bleedMode}
                onChange={(event) =>
                  change({
                    bleedMode: event.target.value as PrintSettings["bleedMode"],
                  })
                }
              >
                <option value="solid">Solid color</option>
                <option value="mirror">Mirror edge</option>
                <option value="edge">Extend edge</option>
              </select>
            </label>
            <label className="setting-row">
              Border / corner color
              <input
                type="color"
                value={settings.bleedColor}
                onChange={(event) => change({ bleedColor: event.target.value })}
              />
            </label>
            <p className="hint">
              Existing MPC bleed is cropped first. Your chosen bleed is then
              added outside the card's trim line.
            </p>
          </section>
          <section className="panel settings-panel">
            <h3>Cut guides</h3>
            <label className="setting-row">
              Style
              <select
                value={settings.guides}
                onChange={(event) =>
                  change({
                    guides: event.target.value as PrintSettings["guides"],
                  })
                }
              >
                <option value="crop">Outer crop marks</option>
                <option value="full">Full cutting lines</option>
                <option value="none">None</option>
              </select>
            </label>
            {settings.guides !== "none" && (
              <>
                <NumberSetting
                  label="Line thickness"
                  value={settings.guideWidthPt}
                  min={0.1}
                  max={2}
                  step={0.05}
                  unit="pt"
                  set={(value) => change({ guideWidthPt: value })}
                />
                <label className="setting-row">
                  Guide color
                  <input
                    type="color"
                    value={settings.guideColor}
                    onChange={(event) =>
                      change({ guideColor: event.target.value })
                    }
                  />
                </label>
              </>
            )}
            {settings.guides === "crop" && (
              <>
                <NumberSetting
                  label="Mark length"
                  value={settings.guideLengthMm}
                  min={0.5}
                  max={10}
                  set={(value) => change({ guideLengthMm: value })}
                />
                <NumberSetting
                  label="Mark offset"
                  value={settings.guideOffsetMm}
                  min={0}
                  max={5}
                  set={(value) => change({ guideOffsetMm: value })}
                />
              </>
            )}
            {settings.guides === "full" && (
              <p className="hint warning-text">
                Full lines cross the trim edges. Use outer crop marks if you do
                not want ink along the cut.
              </p>
            )}
          </section>
          <section className="panel settings-panel">
            <h3>Output & local AI</h3>
            <label className="setting-row">
              Resolution
              <select
                value={settings.dpi}
                onChange={(event) =>
                  change({ dpi: Number(event.target.value) })
                }
              >
                <option value={300}>300 DPI · proof</option>
                <option value={600}>600 DPI · home print</option>
                <option value={1200}>1200 DPI · high resolution</option>
                {![300, 600, 1200].includes(settings.dpi) && (
                  <option value={settings.dpi}>{settings.dpi} DPI</option>
                )}
              </select>
            </label>
            <NumberSetting
              label="Custom resolution"
              min={150}
              max={1200}
              step={1}
              unit="dpi"
              value={settings.dpi}
              set={(value) => change({ dpi: value })}
            />
            <NumberSetting
              label="JPEG quality"
              min={60}
              max={100}
              step={1}
              unit="%"
              value={settings.quality}
              set={(value) => change({ quality: value })}
            />
            <label className="check-label">
              <input
                type="checkbox"
                checked={settings.upscale}
                disabled={!system.data?.upscaler.available}
                onChange={(event) => change({ upscale: event.target.checked })}
              />
              Use local AI upscaling
            </label>
            <p className="hint">
              {system.data?.upscaler.available
                ? "NMKD Siax 4× · Upscayl engine. Runs locally, only when source resolution is below the target."
                : (system.data?.upscaler.reason ?? "Checking local AI engine…")}
            </p>
            <p className="hint">
              AI can change fine text. Export one proof sheet before processing
              the full deck. Preview uses 150 DPI without AI.
            </p>
            <ErrorNotice
              error={system.error}
              retry={() => void system.refetch()}
            />
          </section>
          <section className="panel settings-panel">
            <h3>Backs & duplex</h3>
            <label className="setting-row">
              Back pages
              <select
                value={settings.backs}
                onChange={(event) => {
                  change({
                    backs: event.target.value as PrintSettings["backs"],
                  });
                  setBack(false);
                }}
              >
                <option value="none">Fronts only</option>
                <option value="long-edge">Duplex · flip long edge</option>
                <option value="short-edge">Duplex · flip short edge</option>
                <option value="separate">All fronts, then all backs</option>
              </select>
            </label>
            {settings.backs !== "none" && (
              <>
                <NumberSetting
                  label="Back horizontal offset"
                  min={-10}
                  max={10}
                  value={settings.backOffsetXmm}
                  set={(value) => change({ backOffsetXmm: value })}
                />
                <NumberSetting
                  label="Back vertical offset"
                  min={-10}
                  max={10}
                  value={settings.backOffsetYmm}
                  set={(value) => change({ backOffsetYmm: value })}
                />
                <p className="hint">
                  Double-faced cards use their reverse face. Other cards use the
                  Deckpress playtest back unless you choose a back in Art
                  studio. Separate sheets use long-edge alignment.
                </p>
              </>
            )}
          </section>
          <section className="panel settings-panel">
            <h3>Include & page range</h3>
            {(
              [
                ["includeSideboard", "Include sideboard"],
                ["includeMaybeboard", "Include maybeboard"],
                ["skipBasics", "Skip basic lands"],
              ] as const
            ).map(([key, label]) => (
              <label className="check-label" key={key}>
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(event) => change({ [key]: event.target.checked })}
                />
                {label}
              </label>
            ))}
            <NumberSetting
              label="First sheet"
              min={1}
              max={1000}
              step={1}
              unit=""
              value={settings.pageFrom}
              set={(value) => change({ pageFrom: value })}
            />
            <NumberSetting
              label="Last sheet · 0 is all"
              min={0}
              max={1000}
              step={1}
              unit=""
              value={settings.pageTo}
              set={(value) => change({ pageTo: value })}
            />
            <p className="hint">
              Use sheet ranges to split large exports. Both faces of a duplex
              sheet stay together.
            </p>
          </section>
        </div>
        <section className="proof-area">
          <div className="proof-sticky">
            <div className="toolbar">
              <button
                type="button"
                className="icon-button"
                aria-label="Previous sheet"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                <ArrowLeft size={15} />
              </button>
              <span className="mono">
                Sheet {totalSheets ? currentPage + 1 : 0} of {totalSheets}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Next sheet"
                disabled={page + 1 >= selectedSheets}
                onClick={() => setPage(page + 1)}
              >
                <ArrowRight size={15} />
              </button>
              <div className="spacer" />
              <div className="segmented">
                <button
                  type="button"
                  aria-pressed={!back}
                  onClick={() => setBack(false)}
                >
                  Fronts
                </button>
                <button
                  type="button"
                  aria-pressed={back}
                  disabled={settings.backs === "none"}
                  onClick={() => setBack(true)}
                >
                  Backs
                </button>
              </div>
            </div>
            <div
              className="proof-canvas"
              aria-busy={previewSettings !== settings}
            >
              {layout && selectedSheets > 0 ? (
                <svg
                  className="proof-sheet"
                  style={{
                    width: `min(100%, ${(66 * layout.width) / layout.height}vh, ${(650 * layout.width) / layout.height}px)`,
                  }}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  role="img"
                  aria-label={`Print preview, ${paperNames[settings.paper]}, ${layout.columns} columns by ${layout.rows} rows`}
                >
                  <title>
                    Sheet {currentPage + 1} {back ? "backs" : "fronts"}, exact
                    print geometry
                  </title>
                  <rect
                    width={layout.width}
                    height={layout.height}
                    fill="white"
                  />
                  {pageCards.map((entry, index) => {
                    const raw = layout.slots[index];
                    if (!raw) return null;
                    const slot = back ? duplexSlot(raw, layout, settings) : raw;
                    const art = back ? backArt(entry) : frontArt(entry);
                    return (
                      <g key={`${entry.id}:${slot.x}:${slot.y}`}>
                        <rect
                          {...{
                            x: slot.x,
                            y: slot.y,
                            width: slot.width,
                            height: slot.height,
                          }}
                          fill={settings.bleedColor}
                        />
                        {art ? (
                          <PreviewImage
                            art={art}
                            settings={previewSettings}
                            x={slot.x}
                            y={slot.y}
                            width={slot.width}
                            height={slot.height}
                          />
                        ) : (
                          <>
                            <rect
                              x={slot.trim.x + 8}
                              y={slot.trim.y + 8}
                              width={slot.trim.width - 16}
                              height={slot.trim.height - 16}
                              fill="none"
                              stroke="#cca152"
                            />
                            <text
                              x={slot.trim.x + 22}
                              y={slot.trim.y + slot.trim.height / 2}
                              fill="#e2b25a"
                              fontSize={15}
                              fontFamily="Helvetica"
                            >
                              DECKPRESS
                            </text>
                            <text
                              x={slot.trim.x + 22}
                              y={slot.trim.y + slot.trim.height / 2 + 17}
                              fill="#b3b3b3"
                              fontSize={8}
                              fontFamily="Helvetica"
                            >
                              PLAYTEST CARD
                            </text>
                          </>
                        )}
                        {trim && (
                          <rect
                            {...slot.trim}
                            fill="none"
                            stroke="#00a3b0"
                            strokeWidth={0.6}
                            strokeDasharray="3 2"
                          />
                        )}
                      </g>
                    );
                  })}
                  {!back &&
                    layout.guides.map((line) => (
                      <line
                        key={`${line.x1}:${line.y1}:${line.x2}:${line.y2}`}
                        {...line}
                        stroke={settings.guideColor}
                        strokeWidth={settings.guideWidthPt}
                      />
                    ))}
                </svg>
              ) : (
                <div className="empty-state">
                  <Printer size={32} />
                  <h3>No printable sheet</h3>
                  <p>
                    {layoutError
                      ? "Adjust the settings so your cards fit."
                      : "Include some cards and check the sheet range."}
                  </p>
                </div>
              )}
            </div>
            <div className="proof-meta">
              <span className="mono">
                {paperNames[settings.paper]} · {layout?.columns ?? 0} ×{" "}
                {layout?.rows ?? 0} · {settings.cardWidthMm} ×{" "}
                {settings.cardHeightMm} mm
              </span>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={trim}
                  onChange={(event) => setTrim(event.target.checked)}
                />
                Show trim boundary
              </label>
            </div>
            <p className="hint">
              Trim boundary is preview-only. Actual bleed and image cropping are
              rendered by the PDF raster pipeline.
            </p>
            <div className="preflight">
              <div className="preflight-title">
                <h3>Print check</h3>
                <span className="badge">sRGB output</span>
              </div>
              <dl>
                <div>
                  <dt>Cards in export</dt>
                  <dd>{selectedCards.length}</dd>
                </div>
                <div>
                  <dt>Raster per card, without bleed</dt>
                  <dd className="mono">
                    {mmToPixels(settings.cardWidthMm, settings.dpi)} ×{" "}
                    {mmToPixels(settings.cardHeightMm, settings.dpi)} px
                  </dd>
                </div>
                <div>
                  <dt>Estimated PDF size</dt>
                  <dd>~{Math.max(0.1, estimatedMB).toFixed(1)} MB</dd>
                </div>
              </dl>
              {lowResolution > 0 && (
                <p className="notice warning">
                  <AlertTriangle size={16} />
                  {lowResolution} unique images below target DPI.{" "}
                  {settings.upscale
                    ? "AI will process lower-resolution sources."
                    : "Resizing alone does not add detail."}
                </p>
              )}
              {settings.marginMm < 4 && (
                <p className="notice warning">
                  Some printers will clip margins below 4 mm.
                </p>
              )}
              <p className="print-reminder">
                <Printer size={17} />
                <span>
                  Print at <strong>100% / actual size.</strong> Turn off “Fit to
                  page”. Check a ruler against the first sheet.
                </span>
              </p>
              <button
                type="button"
                className="primary wide"
                disabled={!valid || task.busy}
                onClick={start}
              >
                <Download size={16} />
                Generate PDF
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function NumberSetting({
  label,
  value,
  set,
  min,
  max,
  step = 0.1,
  unit = "mm",
}: {
  label: string;
  value: number;
  set: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  return (
    <label className="setting-row">
      {label}
      <span className="number-unit">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => set(Number(event.target.value))}
        />
        <span>{unit}</span>
      </span>
    </label>
  );
}

function PreviewImage({
  art,
  settings,
  x,
  y,
  width,
  height,
}: {
  art: Art;
  settings: PrintSettings;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const key = new URLSearchParams({
    art: JSON.stringify(art),
    settings: JSON.stringify({
      cardWidthMm: settings.cardWidthMm,
      cardHeightMm: settings.cardHeightMm,
      bleedMm: settings.bleedMm,
      bleedMode: settings.bleedMode,
      bleedColor: settings.bleedColor,
    }),
  });
  return (
    <ProofImage
      key={key.toString()}
      url={`/api/preview?${key}`}
      x={x}
      y={y}
      width={width}
      height={height}
    />
  );
}

function ProofImage({
  url,
  x,
  y,
  width,
  height,
}: {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return failed ? (
    <g>
      <rect x={x} y={y} width={width} height={height} fill="#f4dedb" />
      <text x={x + 8} y={y + height / 2} fill="#8c2323" fontSize={10}>
        Image failed to load
      </text>
    </g>
  ) : (
    <g>
      <image
        href={url}
        x={x}
        y={y}
        width={width}
        height={height}
        preserveAspectRatio="none"
        data-loaded={loaded}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
      {!loaded && (
        <text x={x + 8} y={y + height / 2} fill="#cccccc" fontSize={9}>
          Preparing preview…
        </text>
      )}
    </g>
  );
}
