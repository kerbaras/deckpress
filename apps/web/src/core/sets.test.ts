import { expect, it } from "vitest";
import {
  formatSetCoverage,
  type SetCoverage,
  type SetInfo,
  searchSets,
  suggestedSets,
} from "./sets.ts";

const set = (
  code: string,
  name: string,
  changes: Partial<SetInfo> = {},
): SetInfo => ({
  code,
  name,
  setType: "expansion",
  parentSetCode: null,
  digital: false,
  releasedAt: "2026-01-23",
  iconSvgUri: `https://svgs.scryfall.io/sets/${code}.svg`,
  cardCount: 100,
  ...changes,
});

const ecl = set("ecl", "Lorwyn Eclipsed");
const ecc = set("ecc", "Lorwyn Eclipsed Commander");
const fdc = set("fdc", "Foundations Commander", { releasedAt: "2024-11-15" });
const fdn = set("fdn", "Foundations", { releasedAt: "2024-11-16" });
const token = set("tecc", "Lorwyn Eclipsed Commander Tokens", {
  setType: "token",
});

it("matches every token, ranking exact code before code prefix and name", () => {
  const sets = [
    set("new", "ECC Booster", { releasedAt: "2026-04-01" }),
    set("ecc2", "Extras", { releasedAt: "2026-03-01" }),
    ecc,
    ecl,
    token,
  ];
  const codes = (query: string) =>
    searchSets(sets, query).map(({ code }) => code);
  expect(codes(" LORWYN   ecl ")).toEqual(["ecl", "ecc", "tecc"]);
  expect(codes("ecc")).toEqual(["ecc", "ecc2", "new"]);
  expect(codes("clipsed mand")).toEqual(["ecc", "tecc"]);
  expect(codes("lorwyn nonexistent")).toEqual([]);
  expect(codes("")[0]).toBe("new");
});

it("filters out digital, memorabilia and alchemy sets from the picker", () => {
  expect(
    searchSets(
      [
        token,
        set("m", "Memorabilia", { setType: "memorabilia" }),
        set("a", "Alchemy", { setType: "alchemy" }),
        set("d", "Digital", { digital: true }),
      ],
      "",
    ),
  ).toEqual([token]);
});

it("orders suggestions by family coverage, exact coverage, release and code", () => {
  const row = (set: SetInfo, count: number, exact: number): SetCoverage => ({
    set,
    count,
    exact,
    total: 60,
  });
  const ranked = suggestedSets([
    row(fdn, 42, 20),
    row(ecl, 42, 20),
    row(fdc, 42, 28),
    row(ecc, 42, 20),
    row(set("higher", "Higher coverage"), 58, 0),
    row(token, 60, 60),
    row(set("zero", "Zero coverage"), 0, 0),
  ]);
  expect(ranked.map(({ set }) => set.code)).toEqual([
    "higher",
    "fdc",
    "ecc",
    "ecl",
    "fdn",
  ]);
  const commander = ranked.find(({ set }) => set.code === "fdc");
  expect(commander && formatSetCoverage(commander)).toBe("42 of 60 cards");
  expect(suggestedSets([])).toEqual([]);
});
