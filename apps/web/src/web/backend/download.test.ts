import { afterEach, expect, it, vi } from "vitest";
import { downloadText } from "./download.ts";
import { NotAvailableOnWebError, webBackend } from "./web.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("downloads both supplied export formats with a Blob and cleans up its URL", async () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn(() => "blob:export");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }),
  );
  const clicked: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download);
    expect(this.isConnected).toBe(true);
    expect(this.href).toBe("blob:export");
  });
  const destination = await webBackend.save({
    defaultPath: "deck.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  await expect(
    webBackend.call("save_text", { destination, contents: "{}" }),
  ).resolves.toBeNull();
  await expect(
    webBackend.call("save_mpc_xml", {
      destination: "order.xml",
      contents: "<order/>",
    }),
  ).resolves.toBeNull();
  expect(clicked).toEqual(["deck.json", "order.xml"]);
  expect(createObjectURL.mock.calls).toEqual([
    [expect.objectContaining({ type: "application/json", size: 2 })],
    [expect.objectContaining({ type: "application/xml", size: 8 })],
  ]);
  expect(document.querySelector("a[download]")).toBeNull();
  await vi.runAllTimersAsync();
  expect(revokeObjectURL).toHaveBeenCalledTimes(2);
});

it("leaves other dialogs unsupported and rejects invalid export names or sizes", async () => {
  await expect(
    webBackend.save({ filters: [{ name: "JSON", extensions: ["json"] }] }),
  ).resolves.toBeNull();
  await expect(
    webBackend.save({
      defaultPath: "deck.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    }),
  ).rejects.toBeInstanceOf(NotAvailableOnWebError);
  expect(() => downloadText("deck.txt", "{}", "json")).toThrow(".json");
  expect(() => downloadText("deck.xml", "é".repeat(262_145), "xml")).toThrow(
    "too large",
  );
});

it("returns the browser confirmation decision", async () => {
  const confirm = vi
    .spyOn(window, "confirm")
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(false);
  await expect(webBackend.ask("Delete this deck?", {})).resolves.toBe(true);
  await expect(webBackend.ask("Delete this deck?", {})).resolves.toBe(false);
  expect(confirm).toHaveBeenCalledWith("Delete this deck?");
});
