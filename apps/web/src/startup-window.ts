import { invoke } from "@tauri-apps/api/core";
import { api } from "./api.ts";

export async function migrateAppearance() {
  const appearance = window.deckpressAppearance?.preference;
  if (
    window.deckpressInitialAppearance === undefined &&
    (appearance === "light" || appearance === "dark")
  ) {
    await api.saveAppearance(appearance);
  }
}

export async function showThemedWindow() {
  const canvas = getComputedStyle(document.documentElement)
    .getPropertyValue("--canvas")
    .trim();
  await invoke("show_themed_window", { canvas });
}
