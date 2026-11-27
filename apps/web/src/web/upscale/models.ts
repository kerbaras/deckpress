import manifest from "../../../../../packages/core/models.json";
import { ESRGAN } from "./tiling.ts";

export const upscaleModels = manifest.filter(
  ({ tile, scale }) => tile === ESRGAN.tile && scale === ESRGAN.scale,
);

export const webModels = upscaleModels.filter(({ bundled }) => bundled);
export const defaultWebModel = "realesr-general-x4v3";

export type ModelSpec = Pick<
  (typeof manifest)[number],
  "file" | "bytes" | "sha256"
>;
