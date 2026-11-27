const faceSeparator = " // ";

export function canonicalCardName(name: string): string {
  const compact = name.trim().replace(/\s+/g, " ");
  if (
    !compact.includes("/") ||
    compact.startsWith("/") ||
    compact.endsWith("/")
  )
    return compact;
  return compact
    .split("/")
    .map((face) => face.trim())
    .filter(Boolean)
    .join(faceSeparator);
}

export function cardLookupName(canonicalName: string): string {
  return canonicalName.split(faceSeparator, 1)[0] ?? canonicalName;
}

export function ampersandCardAlternative(canonicalName: string): string | null {
  return canonicalName.includes(" & ") && !canonicalName.includes(faceSeparator)
    ? canonicalName.replaceAll(" & ", faceSeparator)
    : null;
}
