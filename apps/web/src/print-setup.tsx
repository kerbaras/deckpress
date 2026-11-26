import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Download,
  FlipHorizontal2,
  PaintBucket,
  Printer,
  Save,
  UnfoldHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, downloadCutTemplate, previewSrc } from "./api.ts";
import {
  type Art,
  backArt,
  createLayout,
  type Deck,
  duplexRotation,
  duplexSlot,
  effectivePrintSettings,
  fitSheetLabel,
  frontArt,
  MAX_SCM_BLEED_MM,
  mmToPixels,
  mmToPt,
  type PrintSettings,
  printableEntries,
  printPageCount,
  printSettingsSchema,
  type ScmTemplate,
  scmCardLabel,
  scmCards,
  scmCutFile,
  scmPapers,
  sheetLabel,
} from "./core/index.ts";
import { DuplexCalibration } from "./duplex-calibration.tsx";
import { ErrorNotice, ExternalLink, StatusRegion, useTask } from "./ui.tsx";

const paperNames = {
  a4: "A4",
  letter: "US Letter",
  a3: "A3",
  a5: "A5",
  legal: "US Legal",
  tabloid: "Tabloid",
  arch_b: "Arch B (12 × 18 in)",
  custom: "Custom",
};

const scmCardSizes = [...new Set(scmPapers.flatMap(scmCards))].sort();
const scmVariants = [
  { value: "default", label: "Standard layout" },
  { value: "borderless", label: "Borderless layout" },
] as const;
const scmTree =
  "https://github.com/Alan-Cha/silhouette-card-maker/tree/0da09b729814aa5aafde024b5a6059624fa87951";
const scmCuttingTemplates = `${scmTree}/cutting_templates`;
const scmBorderlessDocs = `${scmTree}/hugo/content/miscellaneous/borderless.md`;

export const bleedModes: {
  value: PrintSettings["bleedMode"];
  label: string;
  description: string;
  Icon: typeof FlipHorizontal2;
}[] = [
  {
    value: "mirror",
    label: "Mirror",
    description: "Reflects the card edge so off-cuts stay on art (recommended)",
    Icon: FlipHorizontal2,
  },
  {
    value: "edge",
    label: "Edge",
    description: "Stretches the outermost pixels",
    Icon: UnfoldHorizontal,
  },
  {
    value: "solid",
    label: "Solid",
    description: "Flat colour",
    Icon: PaintBucket,
  },
];

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
  const isScm = settings.layoutMode === "scm";
  const template = settings.scmTemplate;
  const system = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.settings(signal),
  });
  const task = useTask();
  const cutTemplateTask = useTask();
  const [cutTemplatePath, setCutTemplatePath] = useState("");
  const [page, setPage] = useState(0);
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
  const effective = effectivePrintSettings(settings);
  const trimWidth = isScm
    ? Number(effective.cardWidthMm.toFixed(2))
    : effective.cardWidthMm;
  const trimHeight = isScm
    ? Number(effective.cardHeightMm.toFixed(2))
    : effective.cardHeightMm;
  const sheetName = layout?.scm?.name ?? paperNames[settings.paper];
  const cutFile = layout?.scm && scmCutFile(layout.scm.name);
  const changeTemplate = (patch: Partial<ScmTemplate>) =>
    change({ scmTemplate: { ...template, ...patch } });
  const matchingPapers = isScm
    ? scmPapers.filter((paper) => scmCards(paper).includes(template.card))
    : [];
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
  const { pdfPages, calibrationPages } = printPageCount(
    selectedSheets,
    effective,
  );
  const models = system.data?.models ?? [];
  const selectedModel =
    models.find((model) => model.id === settings.upscaleModel) ??
    models.find((model) => model.id === system.data?.defaultModel);
  const upscalerReady = !!selectedModel?.installed;
  const valid =
    !!layout && selectedSheets > 0 && (!settings.upscale || upscalerReady);
  const previewPage = Math.max(0, Math.min(page, pdfPages - 1));
  const calibration = previewPage < calibrationPages;
  const side = previewPage - calibrationPages;
  const duplex =
    effective.backs === "long-edge" || effective.backs === "short-edge";
  const back =
    effective.backs === "separate"
      ? side >= selectedSheets
      : duplex && side % 2 === 1;
  const currentPage =
    first +
    (duplex ? Math.floor(side / 2) : side % Math.max(1, selectedSheets));
  const previewLabel = calibration
    ? previewPage === 0
      ? "Calibration page"
      : "Blank calibration back"
    : `Sheet ${currentPage + 1} · ${back ? "back" : "front"}`;
  const pageCards =
    layout && pdfPages > 0 && !calibration
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
          ...(effective.backs !== "none" && backArt(entry)
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
  const label =
    pdfPages === 0 || calibration
      ? ""
      : layout?.scm
        ? `sheet: ${currentPage + 1}, template: ${layout.scm.name}`
        : sheetLabel(settings, deck.name, currentPage + 1, totalSheets, back);
  const labelPlacement = layout && fitSheetLabel(layout, label);
  const start = () =>
    void task.run(async () => {
      const saved = await onSave(deck);
      await api.createJob(saved.id, settings);
      onJobs();
    });
  return (
    <div className="print-workspace px-6 py-4">
      <div className="print-title toolbar">
        <div>
          <h2>Print setup</h2>
          <p className="text-meta text-muted">
            Physical dimensions first. No hidden scaling.
          </p>
        </div>
        <div className="spacer" />
        <span className="mono muted">
          Trim {trimWidth} × {trimHeight} mm · {selectedSheets} card{" "}
          {selectedSheets === 1 ? "sheet" : "sheets"} · {pdfPages} PDF{" "}
          {pdfPages === 1 ? "page" : "pages"}
          {calibrationPages > 0 &&
            ` (includes ${calibrationPages} calibration ${calibrationPages === 1 ? "page" : "pages"})`}
        </span>
        {isScm ? (
          <span className="muted">
            {cutFile
              ? "Use the SCM .studio3 cut template."
              : "No SCM cut file for this layout."}
          </span>
        ) : (
          <button
            type="button"
            disabled={!layout || cutTemplateTask.busy}
            onClick={() =>
              void cutTemplateTask.run(async () => {
                setCutTemplatePath("");
                setCutTemplatePath((await downloadCutTemplate(deck)) ?? "");
              })
            }
          >
            Export cut template (SVG)
          </button>
        )}
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
      <ErrorNotice error={cutTemplateTask.error} />
      <StatusRegion
        className={cutTemplatePath ? "notice success" : "sr-only"}
        label="Cut template export status"
      >
        {cutTemplatePath && `Cut template saved to ${cutTemplatePath}`}
      </StatusRegion>
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
                <option value="home">Home inkjet · A4 / 800 DPI</option>
                <option value="letter">Home inkjet · Letter / 800 DPI</option>
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
            <h3>Layout mode</h3>
            <label className="setting-row">
              Layout mode
              <select
                value={settings.layoutMode}
                onChange={(event) =>
                  change({
                    layoutMode: event.target.value === "scm" ? "scm" : "free",
                  })
                }
              >
                <option value="free">Free layout</option>
                <option value="scm">Silhouette template (SCM)</option>
              </select>
            </label>
            {isScm && (
              <>
                <label className="setting-row card-size-setting">
                  Template card size
                  <select
                    value={
                      scmCardSizes.includes(template.card) ? template.card : ""
                    }
                    onChange={(event) => {
                      const card = event.target.value;
                      const paper = scmCards(template.paper).includes(card)
                        ? template.paper
                        : scmPapers.find((paper) =>
                            scmCards(paper).includes(card),
                          );
                      if (paper) changeTemplate({ paper, card });
                    }}
                  >
                    <option value="" disabled>
                      Choose a card size
                    </option>
                    {scmCardSizes.map((card) => (
                      <option key={card} value={card}>
                        {scmCardLabel(card)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="setting-row card-size-setting">
                  Silhouette Cameo template
                  <select
                    value={
                      matchingPapers.includes(template.paper)
                        ? `${template.paper}:${template.variant}`
                        : ""
                    }
                    onChange={(event) => {
                      const [paper, variant] = event.target.value.split(":");
                      if (paper) {
                        changeTemplate({
                          paper,
                          variant:
                            variant === "borderless" ? "borderless" : "default",
                        });
                      }
                    }}
                  >
                    <option value="" disabled>
                      Choose a template
                    </option>
                    {matchingPapers.map((paper) => {
                      const name = paperNames[paper as keyof typeof paperNames];
                      return (
                        <optgroup key={paper} label={name}>
                          {scmVariants.map(({ value, label }) => (
                            <option key={value} value={`${paper}:${value}`}>
                              {name} · {label}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </label>
                <label className="setting-row">
                  SCM registration marks
                  <select
                    value={template.marks}
                    onChange={(event) =>
                      changeTemplate({
                        marks: event.target.value === "4" ? 4 : 3,
                      })
                    }
                  >
                    <option value="3">3 marks</option>
                    <option value="4">4 marks</option>
                  </select>
                </label>
                {layout?.scm && (
                  <>
                    <h3>Fixed by template</h3>
                    <dl
                      className="scm-template-details"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      <div>
                        <dt>Paper & orientation</dt>
                        <dd>
                          {
                            paperNames[
                              template.paper as keyof typeof paperNames
                            ]
                          }{" "}
                          · {layout.scm.orientation}
                        </dd>
                      </div>
                      <div>
                        <dt>Card trim</dt>
                        <dd className="mono">
                          {trimWidth} × {trimHeight} mm
                        </dd>
                      </div>
                      <div>
                        <dt>Grid</dt>
                        <dd className="mono">
                          {layout.columns} × {layout.rows} ·{" "}
                          {layout.slots.length} cards per sheet
                        </dd>
                      </div>
                      {cutFile && (
                        <div>
                          <dt>Cut file</dt>
                          <dd>
                            <code>{cutFile}</code>
                          </dd>
                        </div>
                      )}
                    </dl>
                    {cutFile ? (
                      <ExternalLink href={scmCuttingTemplates}>
                        SCM cutting templates
                      </ExternalLink>
                    ) : (
                      <p className="scm-cut-warning my-0 text-meta text-warning-ink">
                        No SCM cut file for this layout.{" "}
                        <ExternalLink href={scmBorderlessDocs}>
                          SCM borderless docs
                        </ExternalLink>
                      </p>
                    )}
                    <p className="my-0 text-meta text-muted">
                      Registration marks replace crop guides. Template spacing
                      replaces free margins and gaps. Duplex uses long-edge
                      alignment.
                    </p>
                  </>
                )}
              </>
            )}
          </section>
          <section className="panel settings-panel" hidden={isScm}>
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
          <section className="panel settings-panel" hidden={isScm}>
            <h3>Cards & layout</h3>
            <label className="setting-row card-size-setting">
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
                <option value="63.5x88.9">
                  Poker / MPC 63.5 × 88.9 mm (larger than MTG)
                </option>
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
              max={isScm ? MAX_SCM_BLEED_MM : 5}
              step={isScm ? 0.001 : 0.1}
              value={effective.bleedMm}
              set={(value) =>
                change({
                  bleedMm: isScm ? Math.min(value, MAX_SCM_BLEED_MM) : value,
                })
              }
            />
            {isScm && (
              <p className="notice warning" role="status">
                SCM limits bleed to 0.625 mm per side to keep it within the
                template spacing.
              </p>
            )}
            <BleedModeControl
              value={settings.bleedMode}
              onChange={(bleedMode) => change({ bleedMode })}
            />
            <label
              className="setting-row"
              aria-disabled={settings.bleedMode !== "solid"}
            >
              Solid colour
              <input
                type="color"
                value={settings.bleedColor}
                disabled={settings.bleedMode !== "solid"}
                onChange={(event) => change({ bleedColor: event.target.value })}
              />
            </label>
            <p className="hint">
              Existing MPC bleed is cropped first. Your chosen bleed is then
              added outside the card's trim line.
            </p>
            {!isScm && settings.bleedMm > settings.gapMm / 2 && (
              <p className="hint warning-text">
                Bleed exceeds half the gap. It can overlap neighbouring cards in
                a cutter template that measures gaps between trim edges.
                Deckpress adds the gap between bleed edges.
              </p>
            )}
          </section>
          <section className="panel settings-panel" hidden={isScm}>
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
                <option value="crop">Crop marks (sheet and card)</option>
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
                <p className="hint">
                  Marks in the sheet margin line up every cut. Each card also
                  gets corner ticks in the bleed between neighbours
                  {settings.bleedMm + settings.gapMm <= 0.5
                    ? "; add bleed or a gap to make room for them"
                    : ""}
                  . Duplex sheets add registration targets on both faces.
                </p>
              </>
            )}
            {settings.guides === "full" && (
              <p className="hint warning-text">
                Full lines cross the trim edges. Use crop marks if you do not
                want ink along the cut.
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
                <option value={800}>800 DPI · recommended</option>
                <option value={1200}>1200 DPI · print shop</option>
                {![300, 600, 800, 1200].includes(settings.dpi) && (
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
                disabled={!system.data}
                onChange={(event) => change({ upscale: event.target.checked })}
              />
              Use local AI upscaling
            </label>
            <label className="setting-row">
              Model
              <select
                value={selectedModel?.id ?? ""}
                disabled={!settings.upscale || models.length === 0}
                onChange={(event) =>
                  change({ upscaleModel: event.target.value })
                }
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.installed ? "" : " · download required"}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              {system.data
                ? upscalerReady
                  ? `Real-ESRGAN 4× through ONNX Runtime${
                      system.data.loaded
                        ? ` on ${system.data.loaded.executionProvider}`
                        : ""
                    }. Runs on this machine, only when a scan is below the target resolution.`
                  : "Download the selected model under Settings → Local AI upscaling before exporting."
                : "Checking the local AI engine…"}
            </p>
            <p className="hint">
              AI can change fine text. Export one proof sheet before processing
              the full deck. Preview uses 150 DPI without AI.
            </p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={settings.calibrationPage}
                onChange={(event) =>
                  change({ calibrationPage: event.target.checked })
                }
              />
              Add a print-size calibration page
            </label>
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
                value={effective.backs}
                onChange={(event) =>
                  change({
                    backs: event.target.value as PrintSettings["backs"],
                  })
                }
              >
                <option value="none">Fronts only</option>
                <option value="long-edge">Duplex · flip long edge</option>
                {!isScm && (
                  <option value="short-edge">Duplex · flip short edge</option>
                )}
                <option value="separate">All fronts, then all backs</option>
              </select>
            </label>
            {effective.backs !== "none" && (
              <p className="hint">
                Double-faced cards use their reverse face. Other cards use the
                Deckpress playtest back unless you choose a back in Art studio.
                Separate sheets use long-edge alignment.
              </p>
            )}
          </section>
          <DuplexCalibration
            settings={settings}
            backs={effective.backs}
            onChange={change}
          />
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
                aria-label="Previous page"
                disabled={previewPage === 0}
                onClick={() => setPage(previewPage - 1)}
              >
                <ArrowLeft size={15} />
              </button>
              <span className="mono" aria-live="polite" aria-atomic="true">
                Page {pdfPages ? previewPage + 1 : 0} of {pdfPages}
                {pdfPages > 0 && ` · ${previewLabel}`}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Next page"
                disabled={previewPage + 1 >= pdfPages}
                onClick={() => setPage(previewPage + 1)}
              >
                <ArrowRight size={15} />
              </button>
            </div>
            <div
              className="proof-canvas"
              aria-busy={previewSettings !== settings}
            >
              {layout && calibration ? (
                <CalibrationProof
                  layout={layout}
                  blank={previewPage > 0}
                  label={previewLabel}
                />
              ) : layout && pdfPages > 0 ? (
                <svg
                  className="proof-sheet"
                  style={{
                    width: `min(100%, ${(66 * layout.width) / layout.height}vh, ${(650 * layout.width) / layout.height}px)`,
                  }}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  role="img"
                  aria-label={`Print preview, ${sheetName}, ${layout.columns} columns by ${layout.rows} rows`}
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
                      <g
                        key={`${entry.id}:${slot.x}:${slot.y}`}
                        transform={
                          [
                            back ? duplexRotation(layout, settings) : undefined,
                            back && layout.scm?.orientation === "landscape"
                              ? `rotate(180 ${slot.x + slot.width / 2} ${slot.y + slot.height / 2})`
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                      >
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
                  {layout.registration.map((mark) => (
                    <g
                      key={`${mark.x}:${mark.y}`}
                      fill="none"
                      stroke={settings.guideColor}
                      strokeWidth={0.25}
                    >
                      <circle cx={mark.x} cy={mark.y} r={mark.radius} />
                      <line
                        x1={mark.x - mark.radius * 1.6}
                        x2={mark.x + mark.radius * 1.6}
                        y1={mark.y}
                        y2={mark.y}
                      />
                      <line
                        x1={mark.x}
                        x2={mark.x}
                        y1={mark.y - mark.radius * 1.6}
                        y2={mark.y + mark.radius * 1.6}
                      />
                    </g>
                  ))}
                  {layout.scm?.marks.map((mark) => (
                    <rect
                      key={`${mark.x}:${mark.y}:${mark.width}`}
                      {...mark}
                      fill="#000000"
                    />
                  ))}
                  {labelPlacement && (
                    <text
                      x={labelPlacement.x}
                      y={labelPlacement.baseline}
                      fill={layout.scm ? "#000000" : settings.guideColor}
                      fontSize={labelPlacement.fontSizePt}
                      fontFamily="ui-monospace, monospace"
                      textLength={labelPlacement.width}
                      lengthAdjust="spacingAndGlyphs"
                      xmlSpace="preserve"
                    >
                      {label}
                    </text>
                  )}
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
                {sheetName} · {layout?.columns ?? 0} × {layout?.rows ?? 0} ·{" "}
                {trimWidth} × {trimHeight} mm
              </span>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={trim}
                  disabled={pdfPages === 0 || calibration}
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
                    {mmToPixels(effective.cardWidthMm, settings.dpi)} ×{" "}
                    {mmToPixels(effective.cardHeightMm, settings.dpi)} px
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

function CalibrationProof({
  layout,
  blank,
  label,
}: {
  layout: ReturnType<typeof createLayout>;
  blank: boolean;
  label: string;
}) {
  const compact = layout.width < mmToPt(135) || layout.height < mmToPt(145);
  const margin = mmToPt(compact ? 5 : 15);
  const ruleY = compact ? mmToPt(20) : margin + 59;
  const boxY = compact ? mmToPt(29) : ruleY + mmToPt(5) + 33;
  const rulerMm = compact && layout.width < mmToPt(60) ? 20 : 50;
  const tickMm = compact ? 5 : 1;
  const showBox =
    !compact || (layout.width >= mmToPt(73) && layout.height >= mmToPt(122));
  const heading = compact
    ? "Deckpress print-size check"
    : "Deckpress calibration page";
  const blankNote = "Back of the calibration page. Intentionally blank.";
  const fittedSize = (value: string, maxSize: number) =>
    Math.min(maxSize, (layout.width - mmToPt(6)) / (0.6 * value.length));
  return (
    <svg
      className="proof-sheet"
      style={{
        width: `min(100%, ${(66 * layout.width) / layout.height}vh, ${(650 * layout.width) / layout.height}px)`,
      }}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={label}
      fill="var(--preview-loading-text)"
    >
      {blank ? (
        <text x={mmToPt(3)} y={mmToPt(6)} fontSize={fittedSize(blankNote, 8.5)}>
          {blankNote}
        </text>
      ) : (
        <>
          <text
            x={compact ? mmToPt(3) : margin}
            y={compact ? mmToPt(6) : margin + 14}
            fontSize={fittedSize(heading, compact ? 10 : 14)}
          >
            {heading}
          </text>
          <text
            x={compact ? mmToPt(3) : margin}
            y={compact ? mmToPt(11) : margin + 33}
            fontSize={compact ? 8 : 8.5}
          >
            {compact
              ? "Print at actual size (100%)."
              : "Print at 100% / actual size. Measure from line centre to line centre."}
          </text>
          <g stroke="var(--preview-loading-text)" strokeWidth={0.5} fill="none">
            <path d={`M ${margin} ${ruleY} h ${mmToPt(rulerMm)}`} />
            {Array.from({ length: rulerMm / tickMm + 1 }, (_, index) => {
              const mm = index * tickMm;
              const x = margin + mmToPt(mm);
              const tick = mmToPt(
                compact ? 3 : mm % 10 === 0 ? 5 : mm % 5 === 0 ? 3 : 1.5,
              );
              return (
                <line key={x} x1={x} x2={x} y1={ruleY} y2={ruleY + tick} />
              );
            })}
            {showBox && (
              <rect
                x={margin}
                y={boxY}
                width={mmToPt(63)}
                height={mmToPt(88)}
              />
            )}
          </g>
          <text
            x={compact ? mmToPt(3) : margin}
            y={compact ? mmToPt(15) : boxY - 11}
            fontSize={8}
          >
            {rulerMm} mm ruler, {tickMm} mm ticks
          </text>
          {showBox && (
            <text x={margin + 10} y={boxY + 18} fontSize={compact ? 8 : 9}>
              63 × 88 mm MTG reference
            </text>
          )}
        </>
      )}
    </svg>
  );
}

function BleedModeControl({
  value,
  onChange,
}: {
  value: PrintSettings["bleedMode"];
  onChange: (value: PrintSettings["bleedMode"]) => void;
}) {
  return (
    <fieldset className="bleed-fill">
      <legend>Fill</legend>
      {bleedModes.map(({ value: mode, label, description, Icon }) => (
        <label key={mode}>
          <input
            type="radio"
            name="bleed-fill"
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
          />
          <Icon size={15} aria-hidden="true" />
          <span>
            <strong>{label}</strong>
            <span className="hint">{description}</span>
          </span>
        </label>
      ))}
    </fieldset>
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
  const effective = effectivePrintSettings(settings);
  const url = previewSrc(art, {
    cardWidthMm: effective.cardWidthMm,
    cardHeightMm: effective.cardHeightMm,
    bleedMm: effective.bleedMm,
    bleedMode: settings.bleedMode,
    bleedColor: settings.bleedColor,
  });
  return (
    <ProofImage key={url} url={url} x={x} y={y} width={width} height={height} />
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
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill="var(--preview-error-bg)"
      />
      <text
        x={x + 8}
        y={y + height / 2}
        fill="var(--preview-error-text)"
        fontSize={10}
      >
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
        <>
          <rect x={x} y={y} width={width} height={height} fill="var(--paper)" />
          <text
            x={x + 8}
            y={y + height / 2}
            fill="var(--preview-loading-text)"
            fontSize={9}
          >
            Preparing preview…
          </text>
        </>
      )}
    </g>
  );
}
