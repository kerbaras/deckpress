import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { AppError } from "./errors.ts";

const exec = promisify(execFile);
const configSchema = z.object({
  binary: z.string().min(1),
  models: z.string().min(1),
  model: z.string().regex(/^[\w.-]+$/),
  engine: z.enum(["upscayl", "realesrgan"]).default("upscayl"),
});
export interface UpscalerStatus {
  available: boolean;
  model: string;
  scale: number;
  reason: string;
}

export class Upscaler {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private async config() {
    const raw: unknown = process.env.UPSCALE_BIN
      ? {
          binary: process.env.UPSCALE_BIN,
          models: process.env.UPSCALE_MODELS,
          model: process.env.UPSCALE_MODEL ?? "4x_NMKD-Siax_200k",
          engine: process.env.UPSCALE_ENGINE ?? "upscayl",
        }
      : JSON.parse(
          await readFile(join(this.root, "upscaler/config.json"), "utf8"),
        );
    const config = configSchema.parse(raw);
    await Promise.all([
      access(config.binary),
      access(join(config.models, `${config.model}.param`)),
      access(join(config.models, `${config.model}.bin`)),
    ]);
    return config;
  }

  async status(): Promise<UpscalerStatus> {
    try {
      const config = await this.config();
      return {
        available: true,
        model: config.model,
        scale: 4,
        reason:
          "Local GPU engine configured. AI output can alter small text; inspect it before printing.",
      };
    } catch {
      return {
        available: false,
        model: "4x_NMKD-Siax_200k",
        scale: 4,
        reason:
          "Run pnpm setup:upscaler, or configure UPSCALE_BIN and UPSCALE_MODELS in apps/api/.env.",
      };
    }
  }

  async run(input: Buffer, signal: AbortSignal): Promise<Buffer> {
    let config: z.infer<typeof configSchema>;
    try {
      config = await this.config();
    } catch {
      throw new AppError(
        "AI upscaling is not configured. Run pnpm setup:upscaler or disable AI upscaling.",
        503,
      );
    }
    const key = createHash("sha256")
      .update(input)
      .update(JSON.stringify(config))
      .digest("hex");
    const cache = join(this.root, "upscaled");
    await mkdir(cache, { recursive: true });
    const outputPath = join(cache, `${key}.png`);
    try {
      return await readFile(outputPath);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const work = await mkdtemp(join(cache, "work-"));
    try {
      signal.throwIfAborted();
      const source = join(work, "input.png");
      const destination = join(work, "output.png");
      const original = await sharp(input)
        .png()
        .toBuffer({ resolveWithObject: true });
      if (original.info.width * original.info.height > 4_000_000)
        throw new AppError(
          "AI input exceeds 4 megapixels. This image is already high-resolution; turn off AI upscaling.",
          422,
        );
      await writeFile(source, original.data);
      const args = [
        "-i",
        source,
        "-o",
        destination,
        "-m",
        config.models,
        "-n",
        config.model,
        "-s",
        "4",
        "-t",
        "256",
        "-f",
        "png",
        ...(config.engine === "upscayl" ? ["-z", "4"] : []),
      ];
      await exec(config.binary, args, {
        signal,
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const result = await readFile(destination);
      const metadata = await sharp(result).metadata();
      if (
        metadata.width !== original.info.width * 4 ||
        metadata.height !== original.info.height * 4
      )
        throw new Error("Engine returned unexpected dimensions");
      await writeFile(outputPath, result);
      return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AppError) throw error;
      throw new AppError(
        "The local AI engine failed. Check GPU/Vulkan support or export without AI; no silent fallback was used.",
        503,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
