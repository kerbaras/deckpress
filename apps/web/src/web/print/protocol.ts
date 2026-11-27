import type {
  Art,
  Deck,
  PrintFailureTarget,
  PrintJob,
  PrintSettings,
} from "../../core/index.ts";

export type PrintRequest =
  | {
      kind: "export";
      format: PrintJob["format"];
      deck: Deck;
      settings: PrintSettings;
    }
  | { kind: "cut"; format: "svg" | "dxf" | "studio3"; settings: PrintSettings }
  | { kind: "calibration"; settings: PrintSettings }
  | { kind: "source-dpi"; settings: PrintSettings; arts: Art[] };

export type SourceReading = {
  effectiveDpi: number;
  belowUpscaleThreshold: boolean;
};

export type PrintResult =
  | {
      kind: "export";
      file: Blob;
      pages: number;
      message: string;
      total: number;
    }
  | { kind: "cut"; file: Blob }
  | { kind: "calibration"; file: Blob }
  | { kind: "source-dpi"; readings: (SourceReading | null)[] };

export type PrintResponse =
  | PrintUpdate
  | { kind: "result"; result: PrintResult }
  | { kind: "error"; message: string; target?: PrintFailureTarget };

export type PrintInitStage = "core" | "model";

export type PrintUpdate =
  | { kind: "init"; stage: PrintInitStage; ready: boolean }
  | { kind: "progress"; completed: number; total: number; message: string };
