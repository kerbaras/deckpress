import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { artSchema, printSettingsSchema } from "../core/index.ts";
import * as sourceDpi from "./source-dpi.ts";
import { usePickerDpi } from "./use-picker-dpi.ts";

const arts = ["selected", "one", "two", "three", "four", "offscreen"].map(
  (id) =>
    artSchema.parse({
      id,
      name: id,
      source: "Test printing",
      provider: "scryfall",
      imageUrl: `https://cards.scryfall.io/png/${id}.png`,
      thumbnailUrl: `https://cards.scryfall.io/normal/${id}.jpg`,
    }),
);
const settings = printSettingsSchema.parse({});

function Picker() {
  const { observeTile, dpi } = usePickerDpi(
    true,
    arts[0] ?? null,
    arts,
    settings,
  );
  return arts.map((art) => (
    <button
      key={art.id}
      ref={observeTile}
      data-source-art={art.id}
      type="button"
    >
      {art.id}: {dpi(art) ?? "unavailable"}
    </button>
  ));
}

function mockVisibility() {
  let notify: (entries: { target: Element; isIntersecting: boolean }[]) => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof notify) {
        notify = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return (ids: string[], isIntersecting: boolean) =>
    act(() => {
      notify(
        ids.map((id) => ({
          target: screen.getByRole("button", { name: new RegExp(`^${id}:`) }),
          isIntersecting,
        })),
      );
    });
}

it("prioritizes the selection and reads only visible tiles, three at a time, publishing each result", async () => {
  const visibility = mockVisibility();
  const pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<number>>
  >();
  const read = vi
    .spyOn(sourceDpi, "readPickerDpi")
    .mockImplementation((art) => {
      const reading = Promise.withResolvers<number>();
      pending.set(art.id, reading);
      return reading.promise;
    });
  const requested = () => read.mock.calls.map(([art]) => art.id);
  render(<Picker />);
  expect(requested()).toEqual(["selected"]);

  visibility(["selected", "one", "two", "three", "four"], true);
  expect(requested()).toEqual(["selected", "one", "two"]);
  visibility(["three"], false);
  await act(() => pending.get("one")?.resolve(251));

  expect(screen.getByRole("button", { name: "one: 251" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "two: unavailable" }),
  ).toBeVisible();
  expect(requested()).toEqual(["selected", "one", "two", "four"]);
});

it("retries a failed reading on reentry but keeps successful readings", async () => {
  const visibility = mockVisibility();
  const failed = Promise.withResolvers<number>();
  const read = vi
    .spyOn(sourceDpi, "readPickerDpi")
    .mockResolvedValueOnce(300)
    .mockReturnValueOnce(failed.promise)
    .mockResolvedValue(254);
  render(<Picker />);
  visibility(["one"], true);
  await act(() => failed.reject(new Error("Image failed to load")));
  expect(
    screen.getByRole("button", { name: "one: unavailable" }),
  ).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);

  visibility(["one"], false);
  visibility(["one"], true);
  expect(await screen.findByRole("button", { name: "one: 254" })).toBeVisible();
  visibility(["one"], false);
  visibility(["one"], true);
  expect(read.mock.calls.map(([art]) => art.id)).toEqual([
    "selected",
    "one",
    "one",
  ]);
});
