import { expect, it } from "vitest";
import { isolationAction } from "./register.ts";

it.each([
  [true, true, true, "clear"],
  [true, false, false, "clear"],
  [false, false, false, "none"],
  [false, true, false, "reload"],
  [false, true, true, "none"],
] as const)(
  "chooses an isolation action (isolated: %s, active worker: %s, attempted reload: %s)",
  (isolated, active, attempted, action) => {
    expect(isolationAction(isolated, active, attempted)).toBe(action);
  },
);
