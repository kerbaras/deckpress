import { z } from "zod";
import type { Art } from "../../core/index.ts";
import { supportedLanguage } from "./languages.ts";
import type { Scryfall } from "./scryfall.ts";
import { normalizeScryfall, usableCard } from "./scryfall-card.ts";

export async function searchArt(
  api: Scryfall,
  oracleId: string,
  page: number,
  face: number,
  language?: string,
) {
  if (language !== undefined && !supportedLanguage(language)) {
    throw new Error("Unsupported print language.");
  }
  if (!z.uuid().safeParse(oracleId).success) {
    return { items: [], page, hasMore: false, total: 0 };
  }
  const { cards, hasMore, total } = await api.search(
    `oracleid:${oracleId} game:paper${language === undefined ? "" : ` lang:${language}`}`,
    page,
  );
  const items = cards.flatMap((raw) => {
    const card = usableCard(raw);
    const art = card?.faces[face];
    return art &&
      card.oracleId === oracleId &&
      (language === undefined || art.language === language)
      ? [art]
      : [];
  });
  return { items, page, hasMore, total };
}

const quality = { missing: 1, placeholder: 2, lowres: 3, highres_scan: 4 };

function preferHighRes(best: Art, candidate: Art) {
  if (
    candidate.illustrationId !== best.illustrationId ||
    candidate.language !== best.language ||
    candidate.scanQuality == null ||
    quality[candidate.scanQuality] < quality.lowres
  )
    return best;
  return best.scanQuality == null ||
    quality[candidate.scanQuality] > quality[best.scanQuality]
    ? candidate
    : best;
}

export async function betterScan(
  api: Scryfall,
  selected: Art,
  oracleId: string,
  face: number,
) {
  if (
    selected.provider !== "scryfall" ||
    selected.scanQuality === "highres_scan"
  )
    return selected;
  const printId = z.uuid().safeParse(selected.id.split(":")[1]);
  if (!printId.success) return selected;
  if (!z.uuid().safeParse(oracleId).success)
    throw new Error("Invalid oracle ID");

  let base = selected;
  if (!base.illustrationId) {
    const art = normalizeScryfall(await api.printing(printId.data)).faces[face];
    if (
      !art ||
      art.language !== base.language ||
      art.imageUrl !== base.imageUrl
    )
      return base;
    base = art;
  }
  if (
    !base.illustrationId ||
    base.scanQuality === "highres_scan" ||
    !supportedLanguage(base.language)
  )
    return base;

  const query = `oracleid:${oracleId} illustration_id:${base.illustrationId} game:paper lang:${base.language}`;
  for (let page = 1; ; page++) {
    const result = await api.search(query, page);
    for (const raw of result.cards) {
      const art = usableCard(raw)?.faces[face];
      if (art) base = preferHighRes(base, art);
    }
    if (!result.hasMore || base.scanQuality === "highres_scan") return base;
  }
}
