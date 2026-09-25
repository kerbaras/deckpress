import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ["@deckpress/source", ...defaultServerConditions],
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "core",
          environment: "node",
          include: ["packages/core/src/**/*.test.ts"],
        },
      },
      "apps/web/vite.config.ts",
    ],
  },
});
