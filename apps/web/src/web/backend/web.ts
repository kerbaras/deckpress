import type { Backend } from "./types.ts";

export class NotAvailableOnWebError extends Error {
  override name = "NotAvailableOnWebError";
}

function notAvailableYet(feature: string): Promise<never> {
  return Promise.reject(
    new NotAvailableOnWebError(`${feature} is not available yet on the web.`),
  );
}

function unsupportedSource(feature: string): Promise<never> {
  return Promise.reject(
    new NotAvailableOnWebError(`${feature} is not available on the web.`),
  );
}

const placeholderImage = () => "about:blank";

export const webBackend: Backend = {
  call(name, args) {
    switch (name) {
      case "import_url":
        return unsupportedSource("Deck URL import");
      case "search_decks":
      case "deck_detail":
      case "import_external_deck":
        return unsupportedSource("External deck browsing and import");
      case "mpc_artwork":
        return unsupportedSource("MPC Autofill");
      case "search_art":
        if (args?.provider === "mpc") return unsupportedSource("MPC Autofill");
        break;
    }
    return notAvailableYet(name);
  },
  uploadArt: () => notAvailableYet("Art upload"),
  matchArtStyle: () => notAvailableYet("Art style matching"),
  imageSrc: placeholderImage,
  uploadTrimSrc: placeholderImage,
  comparisonThumbnailSrc: placeholderImage,
  previewSrc: placeholderImage,
  save: () => notAvailableYet("The save dialog"),
  ask: () => notAvailableYet("The confirmation dialog"),
};
