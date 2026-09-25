import { describe, expect, it } from "vitest";
import { envSchema } from "./env.ts";

describe("API environment", () => {
  it("uses local defaults and accepts an explicit deployment address", () => {
    expect(envSchema.parse({})).toEqual({ HOST: "127.0.0.1", PORT: 3001 });
    expect(envSchema.parse({ HOST: "0.0.0.0", PORT: "8080" })).toEqual({
      HOST: "0.0.0.0",
      PORT: 8080,
    });
  });

  it.each(["", "abc", "0", "-1", "1.5", "65536"])(
    "rejects invalid PORT=%j before binding a socket",
    (PORT) => {
      expect(envSchema.safeParse({ PORT }).success).toBe(false);
    },
  );
});
