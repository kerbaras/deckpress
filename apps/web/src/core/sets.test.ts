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
const promo = set("pfdn", "Foundations Promos", {
  setType: "promo",
  parentSetCode: "fdn",
});
const jumpstart = set("j25", "Foundations Jumpstart", {
  setType: "draft_innovation",
  parentSetCode: "fdn",
});

it("ranks exact names first and puts matching parents before later token and art sets", () => {
  const sets = [
    fdc,
    set("tfdc", "Foundations Commander Tokens", {
      setType: "token",
      parentSetCode: "fdc",
    }),
    set("afdc", "Foundations Commander Art Series", {
      setType: "memorabilia",
      parentSetCode: "fdc",
    }),
  ];
  const codes = (query: string) =>
    searchSets(sets, query).map(({ code }) => code);
  expect(codes("FOUNDATIONS   Commander")).toEqual(["fdc", "afdc", "tfdc"]);
  expect(codes("foundations comm")).toEqual(["fdc", "afdc", "tfdc"]);
  expect(codes("tfdc")).toEqual(["tfdc"]);
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

it("omits memorabilia and alchemy when browsing, while allowing searches for paper sets", () => {
  const memorabilia = set("m", "Memorabilia", { setType: "memorabilia" });
  const alchemy = set("a", "Alchemy", { setType: "alchemy" });
  const digital = set("d", "Digital", { digital: true });
  const sets = [token, memorabilia, alchemy, digital, promo, jumpstart];
  expect(searchSets(sets, "")).toEqual([jumpstart, promo, token]);
  expect(searchSets(sets, "memorabilia")).toEqual([memorabilia]);
  expect(searchSets(sets, "alchemy")).toEqual([alchemy]);
  expect(searchSets(sets, "digital")).toEqual([]);
  expect(searchSets(sets, "pfdn")).toEqual([promo]);
  expect(searchSets(sets, "jumpstart")).toEqual([jumpstart]);
});

it("orders eligible suggestions by exact copies, family copies, release and code", () => {
  const row = (set: SetInfo, count: number, exact: number): SetCoverage => ({
    set,
    count,
    exact,
    total: 100,
  });
  const ranked = suggestedSets([
    row(fdn, 42, 20),
    row(ecl, 42, 20),
    row(fdc, 73, 40),
    row(ecc, 42, 20),
    row(set("higher", "Higher coverage"), 90, 20),
    row(promo, 100, 0),
    row(jumpstart, 100, 15),
    row(set("art", "Art cards", { setType: "memorabilia" }), 60, 60),
    row(set("alchemy", "Alchemy", { setType: "alchemy" }), 60, 60),
    row(set("digital", "Digital", { digital: true }), 60, 60),
    row(token, 60, 60),
    row(set("zero", "Zero coverage"), 0, 0),
  ]);
  expect(ranked.map(({ set }) => set.code)).toEqual([
    "fdc",
    "higher",
    "ecc",
    "ecl",
    "fdn",
  ]);
  const commander = ranked.find(({ set }) => set.code === "fdc");
  expect(commander && formatSetCoverage(commander)).toBe("73 of 100 cards");
  expect(suggestedSets([])).toEqual([]);
});
