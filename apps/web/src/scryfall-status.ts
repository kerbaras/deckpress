import { useSyncExternalStore } from "react";
import { webScryfallRetry } from "./web/backend/web.ts";

export function useScryfallRetry() {
  return useSyncExternalStore(
    webScryfallRetry.subscribe,
    webScryfallRetry.getSnapshot,
  );
}

export function scryfallRetryMessage(seconds: number) {
  return `Scryfall may be rate limiting requests. Waiting up to ${seconds} s to retry…`;
}
