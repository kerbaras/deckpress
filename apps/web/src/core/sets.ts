import { z } from "zod";

export const setInfoSchema = z.object({
  code: z.string(),
  name: z.string(),
  setType: z.string(),
  parentSetCode: z.string().nullable(),
  digital: z.boolean(),
  releasedAt: z.string(),
  iconSvgUri: z.string(),
  cardCount: z.number().int().nonnegative(),
});

export const setCoverageSchema = z.object({
  set: setInfoSchema,
  count: z.number().int().nonnegative(),
  exact: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type SetInfo = z.infer<typeof setInfoSchema>;
export type SetCoverage = z.infer<typeof setCoverageSchema>;

function byRelease(a: SetInfo, b: SetInfo) {
  return (
    b.releasedAt.localeCompare(a.releasedAt) || a.code.localeCompare(b.code)
  );
}

export function searchSets(sets: readonly SetInfo[], query: string): SetInfo[] {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, " ");
  const tokens = normalized ? normalized.split(" ") : [];
  const matches = sets
    .filter(
      (set) =>
        !set.digital &&
        (normalized ||
          (set.setType !== "memorabilia" && set.setType !== "alchemy")),
    )
    .flatMap((set) => {
      const code = set.code.toLowerCase();
      const name = set.name.toLowerCase();
      if (
        !tokens.every((token) => code.startsWith(token) || name.includes(token))
      )
        return [];
      const rank =
        normalized === code || normalized === name
          ? 0
          : tokens.includes(code)
            ? 1
            : tokens.some((token) => code.startsWith(token))
              ? 2
              : 3;
      return [{ set, rank }];
    })
    .sort((a, b) => a.rank - b.rank || byRelease(a.set, b.set));

  const remaining = new Map(matches.map((match) => [match.set.code, match]));
  const ordered: SetInfo[] = [];
  function append(match: (typeof matches)[number]) {
    const { set, rank } = match;
    if (!remaining.delete(set.code)) return;
    if (
      rank !== 0 &&
      set.parentSetCode &&
      (set.setType === "token" || set.setType === "memorabilia")
    ) {
      const parent = remaining.get(set.parentSetCode);
      if (parent) append(parent);
    }
    ordered.push(set);
  }
  for (const match of matches) append(match);
  return ordered;
}

export function suggestedSets(rows: readonly SetCoverage[]): SetCoverage[] {
  return rows
    .filter(
      ({ set, count }) =>
        count > 0 &&
        !set.digital &&
        (set.setType === "expansion" ||
          set.setType === "core" ||
          set.setType === "commander"),
    )
    .sort(
      (a, b) =>
        b.exact - a.exact || b.count - a.count || byRelease(a.set, b.set),
    );
}

export function formatSetCoverage({ count, total }: SetCoverage): string {
  return `${count} of ${total} cards`;
}
