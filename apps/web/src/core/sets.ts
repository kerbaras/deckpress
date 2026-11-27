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

function pickable(set: SetInfo) {
  return (
    !set.digital && set.setType !== "memorabilia" && set.setType !== "alchemy"
  );
}

function byRelease(a: SetInfo, b: SetInfo) {
  return (
    b.releasedAt.localeCompare(a.releasedAt) || a.code.localeCompare(b.code)
  );
}

export function searchSets(sets: readonly SetInfo[], query: string): SetInfo[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return sets
    .filter(pickable)
    .flatMap((set) => {
      const code = set.code.toLowerCase();
      const name = set.name.toLowerCase();
      if (
        !tokens.every((token) => code.startsWith(token) || name.includes(token))
      )
        return [];
      const rank = tokens.includes(code)
        ? 0
        : tokens.some((token) => code.startsWith(token))
          ? 1
          : 2;
      return [{ set, rank }];
    })
    .sort((a, b) => a.rank - b.rank || byRelease(a.set, b.set))
    .map(({ set }) => set);
}

export function suggestedSets(rows: readonly SetCoverage[]): SetCoverage[] {
  return rows
    .filter(
      ({ set, count }) => count > 0 && pickable(set) && set.setType !== "token",
    )
    .sort(
      (a, b) =>
        b.count - a.count || b.exact - a.exact || byRelease(a.set, b.set),
    );
}

export function formatSetCoverage({ count, total }: SetCoverage): string {
  return `${count} of ${total} cards`;
}
