import { z } from "zod";

export const APP_NAME = "Deckpress";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("@deckpress/desktop"),
  version: z.string().optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./import.ts";
export * from "./layout.ts";
export * from "./models.ts";
