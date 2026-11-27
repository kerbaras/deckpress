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

function Picker({ selected = 0 }: { selected?: number }) {
  const { observeTile, dpi } = usePickerDpi(
    true,
    arts[selected] ?? null,
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
    .mockImplementation((art, _, signal) => {
      const reading = Promise.withResolvers<number>();
      pending.set(art.id, reading);
      signal.addEventListener("abort", () => reading.reject(signal.reason), {
        once: true,
      });
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

it.each(["reopen", "card switch"])(
  "shares the read cap across pickers and retries aborted work after %s",
  async (scenario) => {
    const visibility = mockVisibility();
    const reads: {
      id: string;
      signal: AbortSignal;
      finish: (dpi: number) => void;
    }[] = [];
    let active = 0;
    let peak = 0;
    vi.spyOn(sourceDpi, "readPickerDpi").mockImplementation(
      (art, _, signal) => {
        active++;
        peak = Math.max(peak, active);
        const result = Promise.withResolvers<number>();
        reads.push({ id: art.id, signal, finish: result.resolve });
        return result.promise.finally(() => {
          active--;
        });
      },
    );
    const picker = render(<Picker key="front" />);
    visibility(["one", "two", "three"], true);
    expect(reads.map(({ id }) => id)).toEqual(["selected", "one", "two"]);

    const other = render(<Picker selected={5} />);
    expect(reads).toHaveLength(3);
    const next = scenario === "reopen" ? 0 : 4;
    if (scenario === "reopen") {
      picker.unmount();
      render(<Picker selected={next} />);
    } else {
      picker.rerender(<Picker key="next-card" selected={next} />);
    }
    expect(reads.every(({ signal }) => signal.aborted)).toBe(true);
    expect(reads).toHaveLength(3);

    await act(() => {
      for (const read of reads.slice()) read.finish(111);
    });
    expect(reads.map(({ id }) => id)).toEqual([
      "selected",
      "one",
      "two",
      "offscreen",
      next === 0 ? "selected" : "four",
    ]);
    expect(peak).toBe(3);
    await act(() => reads[4]?.finish(300));
    expect(
      screen.getByRole("button", {
        name: next === 0 ? "selected: 300" : "four: 300",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /: 111$/ }),
    ).not.toBeInTheDocument();
    await act(() => reads[3]?.finish(299));
    other.unmount();
  },
);

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
