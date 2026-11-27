import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { artSchema } from "../core/index.ts";
import { ArtImage, CardImage } from "../ui.tsx";
import * as uploadFiles from "./store/upload-files.ts";

const upload = artSchema.parse({
  id: "upload",
  name: "Uploaded art",
  source: "Upload",
  provider: "upload",
  imageUrl: "upload://0f8fad5b-d9cb-469f-a165-70867728950e",
  thumbnailUrl: "upload://0f8fad5b-d9cb-469f-a165-70867728950e",
});

beforeEach(() => {
  vi.stubEnv("VITE_TARGET", "web");
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => "blob:upload"),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearMocks();
});

function srcs(container: HTMLElement) {
  return [...container.querySelectorAll("img")].map((img) =>
    img.getAttribute("src"),
  );
}

it("renders an empty image frame, not a placeholder src, until the upload loads", async () => {
  const { promise, resolve } = Promise.withResolvers<File>();
  vi.spyOn(uploadFiles, "readUploadImage").mockReturnValue(promise);
  const { container } = render(<ArtImage art={upload} name="Uploaded art" />);

  expect(container.querySelector(".card-image")).toBeEmptyDOMElement();
  resolve(new File(["png"], "art.png", { type: "image/png" }));
  await waitFor(() => expect(srcs(container)).toEqual(["blob:upload"]));
});

it("shows the unavailable fallback without an image request when the upload fails", async () => {
  vi.spyOn(uploadFiles, "readUploadImage").mockRejectedValue(
    new Error("Uploaded image not found"),
  );
  const { container } = render(<ArtImage art={upload} name="Uploaded art" />);

  expect(await screen.findByText("Image unavailable")).toBeVisible();
  expect(srcs(container)).toEqual([]);
});

it("shows the fallback instead of an image for a source the browser cannot load", () => {
  const { container } = render(
    <CardImage url="https://example.com/art.png" name="Unknown art" />,
  );

  expect(screen.getByText("Image unavailable")).toBeVisible();
  expect(srcs(container)).toEqual([]);
  expect(container.innerHTML).not.toContain("about:blank");
});

it("keeps desktop uploads on dpimg:// URLs", () => {
  vi.stubEnv("VITE_TARGET", "");
  mockIPC(() => undefined);
  const { container, rerender } = render(
    <ArtImage art={upload} name="Uploaded art" />,
  );
  expect(srcs(container)).toEqual([
    "dpimg://localhost/image%2Fupload%3A%2F%2F0f8fad5b-d9cb-469f-a165-70867728950e",
  ]);

  rerender(<ArtImage art={{ ...upload, bleedMm: 3 }} name="Uploaded art" />);
  expect(srcs(container)[0]).toMatch(/^dpimg:\/\/localhost\/upload-trim%2F/);
});
