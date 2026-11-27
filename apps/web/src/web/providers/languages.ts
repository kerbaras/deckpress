const languages = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ja",
  "ko",
  "ru",
  "zhs",
  "zht",
  "he",
  "la",
  "grc",
  "ar",
  "sa",
  "ph",
  "qya",
  "tlh",
  "dw",
]);

export function supportedLanguage(lang: string) {
  return languages.has(lang);
}
