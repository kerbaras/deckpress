import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import legacyBackup from "../../../../../packages/core/tests/fixtures/deck-backup-before-board-names.json";
import {
  api,
  downloadCutTemplate,
  fetchHealth,
  imageSrc,
  UrlImportError,
} from "../../api.ts";
import { deckSchema } from "../../core/index.ts";
import { NotAvailableOnWebError } from "./web.ts";

afterEach(() => vi.unstubAllEnvs());

it("routes commands and image URLs through Tauri when the runtime is present", async () => {
  vi.stubEnv("VITE_TARGET", "");
  const ipc = vi.fn(() => ({ status: "ok", service: "@deckpress/desktop" }));
  mockIPC(ipc);

  await expect(fetchHealth()).resolves.toEqual({
    status: "ok",
    service: "@deckpress/desktop",
  });
  expect(ipc).toHaveBeenCalledWith("health", {});
  expect(imageSrc("art.png")).toBe("dpimg://localhost/image%2Fart.png");
});

it("uses the web backend when Tauri internals are missing", async () => {
  vi.stubEnv("VITE_TARGET", "");
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);

  await expect(fetchHealth()).resolves.toEqual({
    status: "ok",
    service: "@deckpress/desktop",
  });
  expect(imageSrc("art.png")).toBe("about:blank");
  const cdnUrl = "https://cards.scryfall.io/normal/art.jpg";
  expect(imageSrc(cdnUrl)).toBe(cdnUrl);
});

it("uses the web backend for the explicit web target even with Tauri available", async () => {
  vi.stubEnv("VITE_TARGET", "web");
  const ipc = vi.fn();
  mockIPC(ipc);

  const error = await api
    .import({ url: "https://moxfield.com/decks/example" })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(UrlImportError);
  expect(error).toMatchObject({
    message: "Deck URL import is not available on the web.",
  });
  expect(ipc).not.toHaveBeenCalled();
});

it.each(["svg", "dxf", "studio3"] as const)(
  "reports that %s cut template export is not available on the web",
  async (format) => {
    vi.stubEnv("VITE_TARGET", "web");
    const ipc = vi.fn();
    mockIPC(ipc);

    const error = await downloadCutTemplate(
      deckSchema.parse(legacyBackup),
      format,
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(NotAvailableOnWebError);
    expect(error).toMatchObject({
      message: "Cut template export is not available yet on the web.",
    });
    expect(ipc).not.toHaveBeenCalled();
  },
);
