import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./index.ts";

describe("health response contract", () => {
  it.each([
    null,
    {},
    { status: "ok" },
    { status: "unhealthy", service: "@deckpress/api" },
    { status: "ok", service: "another-service" },
  ])("rejects an invalid payload: %j", (payload) => {
    expect(healthResponseSchema.safeParse(payload).success).toBe(false);
  });
});
