import type { Backend } from "./backend-selection.ts";
import type { RgbImage } from "./tiling.ts";

export type WorkerRequest = {
  image: RgbImage;
  model: ArrayBuffer;
  assetBase: string;
};
export type Timing = Backend & { msPerTile: number };
export type UpscaleResult = { image: RgbImage; timing: Timing };
export type WorkerResponse =
  | { kind: "init"; ready: boolean }
  | { kind: "tile"; done: number; total: number; timing: Timing }
  | { kind: "result"; result: UpscaleResult }
  | { kind: "error"; message: string };
