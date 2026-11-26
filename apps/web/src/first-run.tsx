import { ArrowRight, HardDrive, ListPlus, Plus, Wand2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import burnImage from "../../../docs/prototype/assets/48fcafcca79ea3dd7877c5b56f9fecb3.jpg";
import cubeImage from "../../../docs/prototype/assets/87e0158039c89cf1bdd854a215188d1d.jpg";
import atraxaImage from "../../../docs/prototype/assets/06140bf59bb49753e6e56092cfe63477.jpg";
import { api, importedDeckFields } from "./api.ts";
import type { Deck } from "./core/index.ts";
import { ImportDeck } from "./import-deck.tsx";
import { ErrorNotice, useTask } from "./ui.tsx";

const samples = [
  {
    name: "Boros Burn",
    format: "Modern" as const,
    image: burnImage,
    description: "A 60-card canvas of fire and lightning.",
    text: "Deck\n4 Monastery Swiftspear (KTK) 118\n4 Goblin Guide (ZEN) 126\n4 Eidolon of the Great Revel (JOU) 94\n4 Lightning Bolt (M10) 146\n4 Boros Charm (GTC) 148\n4 Lightning Helix (RAV) 213\n4 Searing Blaze (WWK) 90\n4 Lava Spike (CHK) 178\n4 Rift Bolt (TSP) 176\n4 Skewer the Critics (RNA) 115\n4 Sacred Foundry (GRN) 254\n4 Inspiring Vantage (KLD) 246\n4 Sunbaked Canyon (MH1) 247\n4 Arid Mesa (ZEN) 211\n4 Mountain (M21) 269",
  },
  {
    name: "Atraxa study",
    format: "Commander" as const,
    image: atraxaImage,
    description: "12 cards to explore. A starter, not a full deck.",
    text: "Commander\n1 Atraxa, Praetors' Voice\nDeck\n1 Sol Ring\n1 Arcane Signet\n1 Swords to Plowshares\n1 Cultivate\n1 Counterspell\n1 Brainstorm\n1 Command Tower\n1 Forest\n1 Island\n1 Plains\n1 Swamp",
  },
  {
    name: "The classics",
    format: "Cube" as const,
    image: cubeImage,
    description: "Nine iconic cards. One perfect proof sheet.",
    text: "1 Black Lotus\n1 Lightning Bolt (M10) 146\n1 Counterspell\n1 Birds of Paradise\n1 Swords to Plowshares\n1 Dark Ritual\n1 Sol Ring\n1 Brainstorm\n1 Llanowar Elves",
  },
];

/** The empty library: start from a list, the guided builder, a blank deck or a sample. */
export function FirstRun({
  onSaved,
  onCreate,
  onBuild,
}: {
  /** Called with each deck saved from here; the caller refreshes and opens it. */
  onSaved: (deck: Deck) => Promise<void>;
  /** Opens the existing name/format dialog for an empty deck. */
  onCreate: () => void;
  onBuild?: () => void;
}) {
  const task = useTask();
  const [importing, setImporting] = useState(false);
  const startSample = (sample: (typeof samples)[number]) =>
    void task.run(async () => {
      const result = await api.import({ text: sample.text });
      if (result.issues.length)
        throw new Error(
          `Sample could not be fully resolved: ${result.issues.map((issue) => issue.input).join(", ")}`,
        );
      await onSaved(
        await api.createDeck({
          name: sample.name,
          format: sample.format,
          ...importedDeckFields(result),
        }),
      );
    });
  return (
    <>
      <section className="first-run" aria-labelledby="first-run-title">
        <h2 id="first-run-title">Start your first deck</h2>
        <p className="first-run-lede">
          Bring a list or build one from suggestions, pick the art for each
          card, and export a PDF at the exact card size.
        </p>
        <div className="first-run-actions">
          <StartAction
            icon={<ListPlus size={20} />}
            label="Import a list"
            hint="Paste text, choose a file, or link a public Moxfield or Archidekt deck."
            onClick={() => setImporting(true)}
          />
          {onBuild && (
            <StartAction
              icon={<Wand2 size={20} />}
              label="Build a deck"
              hint="Pick a format, colours and a theme, then choose from scored suggestions."
              onClick={onBuild}
            />
          )}
        </div>
        <button
          type="button"
          className="quiet first-run-empty"
          onClick={onCreate}
        >
          <Plus size={15} />
          Start an empty deck
        </button>
        <p className="first-run-privacy">
          <HardDrive size={15} aria-hidden="true" />
          <span>
            Your decks, art choices and PDFs stay on this machine. Samples and
            imports look up card data and images online from Scryfall, and URL
            imports read the deck from the site you link.
          </span>
        </p>
      </section>
      <ErrorNotice error={task.error} />
      <div className="section-heading">
        <h3>Or start from a sample</h3>
        <span className="muted">Real cards from Scryfall</span>
      </div>
      <div className="deck-grid sample-grid">
        {samples.map((sample) => (
          <button
            type="button"
            className="deck-tile sample-tile"
            key={sample.name}
            onClick={() => startSample(sample)}
            disabled={task.busy}
          >
            <img className="deck-cover" src={sample.image} alt="" />
            <div className="deck-shade" />
            <span className="deck-format">{sample.format}</span>
            <div className="deck-caption">
              <h2>{sample.name}</h2>
              <p>{sample.description}</p>
              <span className="sample-action">
                {task.busy ? "Resolving cards…" : "Use sample"}
                <ArrowRight size={15} />
              </span>
            </div>
          </button>
        ))}
      </div>
      {importing && (
        <ImportDeck onClose={() => setImporting(false)} onSaved={onSaved} />
      )}
    </>
  );
}

function StartAction({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      className="first-run-action"
      aria-describedby={hintId}
      onClick={onClick}
    >
      <span className="first-run-icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{label}</strong>
      <span id={hintId} className="first-run-hint" aria-hidden="true">
        {hint}
      </span>
      <ArrowRight className="first-run-arrow" size={16} aria-hidden="true" />
    </button>
  );
}
