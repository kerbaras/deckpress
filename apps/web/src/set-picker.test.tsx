import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { api, imageSrc } from "./api.ts";
import { ArtPolicyFields } from "./art-policy.tsx";
import type { ArtPolicy } from "./core/index.ts";
import type { SetInfo } from "./core/sets.ts";

const ecl: SetInfo = {
  code: "ecl",
  name: "Lorwyn Eclipsed",
  setType: "expansion",
  parentSetCode: null,
  digital: false,
  releasedAt: "2026-01-23",
  iconSvgUri: "https://svgs.scryfall.io/sets/ecl.svg",
  cardCount: 408,
};
const ecc: SetInfo = {
  ...ecl,
  code: "ecc",
  name: "Lorwyn Eclipsed Commander",
  setType: "commander",
  parentSetCode: "ecl",
};

function renderPolicy(current?: ArtPolicy, client = new QueryClient()) {
  const onPreview = vi.fn();
  return {
    ...render(
      <QueryClientProvider client={client}>
        <ArtPolicyFields
          deckId="deck"
          revision={1}
          current={current}
          disabled={false}
          busy={false}
          previewButton={null}
          canUndo={false}
          onPreview={onPreview}
          onUndo={vi.fn()}
        />
      </QueryClientProvider>,
    ),
    onPreview,
  };
}

it("navigates suggestions and searches by keyboard, and sends the exact toggle", async () => {
  const user = userEvent.setup();
  const list = vi.spyOn(api, "listSets").mockResolvedValue([ecc, ecl]);
  const coverage = vi.spyOn(api, "setCoverage").mockResolvedValue([
    { set: ecl, count: 21, exact: 10, total: 30 },
    { set: ecc, count: 21, exact: 18, total: 30 },
  ]);
  const client = new QueryClient();
  const { onPreview, unmount } = renderPolicy(undefined, client);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Policy" }),
    "matchSet",
  );
  const exact = screen.getByRole("checkbox", { name: "Only this exact set" });
  const input = screen.getByRole("combobox", { name: "Set" });
  const preview = screen.getByRole("button", { name: "Preview art policy" });
  expect(exact).not.toBeChecked();
  expect(preview).toBeDisabled();
  await user.click(input);
  const suggested = await screen.findByRole("group", {
    name: "Suggested for this deck",
  });
  const [commander, main] = within(suggested).getAllByRole("option");
  expect(commander).toHaveTextContent("ECC");
  expect(commander).toHaveTextContent("21 of 30 cards");
  expect(main).toHaveTextContent("2026-01-23");
  expect(coverage).toHaveBeenCalledWith("deck");
  await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
  expect(input).toHaveAttribute("aria-activedescendant", commander?.id);
  await user.keyboard("{Enter}");
  expect(input).toHaveValue(ecc.name);
  expect(input).toHaveAttribute("aria-expanded", "false");
  await user.click(preview);
  expect(onPreview).toHaveBeenLastCalledWith({
    kind: "matchSet",
    set: "ecc",
    family: true,
  });

  await user.click(input);
  await user.type(input, "lorwyn ecl");
  expect(
    screen.queryByRole("group", { name: "Suggested for this deck" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{ArrowDown}{Escape}");
  expect(input).toHaveValue(ecc.name);
  expect(input).toHaveAttribute("aria-expanded", "false");
  await user.click(input);
  await user.type(input, "ecl");
  await user.keyboard("{ArrowDown}{Enter}");
  await user.click(exact);
  await user.click(preview);
  expect(onPreview).toHaveBeenLastCalledWith({
    kind: "matchSet",
    set: "ecl",
    family: false,
  });
  unmount();
  renderPolicy({ kind: "matchSet", set: "ecl" }, client);
  expect(await screen.findByDisplayValue(ecl.name)).toBeVisible();
  expect(
    screen.getByRole("checkbox", { name: "Only this exact set" }),
  ).toBeChecked();
  expect(list).toHaveBeenCalledTimes(1);
});

it("shows coverage loading and failure without blocking search", async () => {
  const user = userEvent.setup();
  const pending =
    Promise.withResolvers<Awaited<ReturnType<typeof api.setCoverage>>>();
  vi.spyOn(api, "listSets").mockResolvedValue([ecl]);
  vi.spyOn(api, "setCoverage").mockReturnValue(pending.promise);
  renderPolicy({ kind: "matchSet", set: "ecl", family: true });
  expect(
    screen.getByRole("checkbox", { name: "Only this exact set" }),
  ).not.toBeChecked();
  const input = screen.getByRole("combobox", { name: "Set" });
  await user.click(input);
  expect(
    screen.getByText("Finding suggested sets for this deck…"),
  ).toBeVisible();
  pending.reject(new Error("Unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load suggested sets",
  );
  await user.type(input, "unlisted");
  expect(screen.getByText("No matching sets.")).toBeVisible();
  await user.clear(input);
  await user.type(input, "lorwyn");
  await user.click(screen.getByRole("option", { name: /Lorwyn Eclipsed/ }));
  expect(input).toHaveValue(ecl.name);
});

it("uses the thumbnail URI for set icons and falls back to the code", async () => {
  mockIPC(() => null);
  const user = userEvent.setup();
  vi.spyOn(api, "listSets").mockResolvedValue([ecl]);
  vi.spyOn(api, "setCoverage").mockResolvedValue([]);
  renderPolicy({ kind: "matchSet", set: "ecl" });
  await user.click(screen.getByRole("combobox", { name: "Set" }));
  const option = await screen.findByRole("option", { name: /Lorwyn Eclipsed/ });
  const icon = option.querySelector("img");
  expect(icon).toHaveAttribute("src", imageSrc(ecl.iconSvgUri));
  if (!icon) throw new Error("Missing Scryfall set icon");
  fireEvent.error(icon);
  expect(option.querySelector("img")).toBeNull();
  expect(within(option).getByText("ECL", { exact: true })).toBeVisible();
});
