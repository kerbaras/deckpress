const pluralRules = new Intl.PluralRules("en");

export function formatCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
) {
  const forms: Partial<Record<Intl.LDMLPluralRule, string>> = {
    one: singular,
    other: plural,
  };
  return `${count.toLocaleString()} ${forms[pluralRules.select(count)] ?? plural}`;
}
