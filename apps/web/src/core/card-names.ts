const faceSeparator = " // ";

export function cardLookupName(name: string): string {
  const separator = name.indexOf(faceSeparator);
  return separator < 0 ? name : name.slice(0, separator).trimEnd();
}

export function splitCardAlternative(name: string): string | null {
  const compact = name.trim().replace(/\s+/g, " ");
  const split = compact.includes("/")
    ? compact
    : compact.replaceAll(" & ", "/");
  if (!split.includes("/") || split.startsWith("/") || split.endsWith("/"))
    return null;
  return split
    .split("/")
    .map((face) => face.trim())
    .filter(Boolean)
    .join(faceSeparator);
}
