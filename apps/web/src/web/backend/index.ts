import { tauriBackend } from "./tauri.ts";
import type { Backend } from "./types.ts";
import { webBackend } from "./web.ts";

export function getBackend(): Backend {
  if (
    import.meta.env.VITE_TARGET === "web" ||
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in window) ||
    !window.__TAURI_INTERNALS__
  ) {
    return webBackend;
  }
  return tauriBackend;
}
