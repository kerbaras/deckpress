import { expect, it, vi } from "vitest";
import { printSettingsSchema } from "../../core/index.ts";
import { runPrintWorker } from "./jobs.ts";

it("does not start a browser print worker in a production desktop build", async () => {
  vi.stubEnv("PROD", true);
  vi.stubEnv("VITE_TARGET", "");

  await expect(
    runPrintWorker({
      kind: "calibration",
      settings: printSettingsSchema.parse({}),
    }),
  ).rejects.toThrow("The print worker is only available in the web app");
});
