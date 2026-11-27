import { webAssetBase } from "../asset-base.ts";

const reloadGuard = "deckpress-coi-reload";

export function isolationAction(
  isolated: boolean,
  workerActive: boolean,
  reloadAttempted: boolean,
) {
  if (isolated) return "clear";
  if (workerActive && !reloadAttempted) return "reload";
  return "none";
}

function recoverIsolation(workerActive: boolean) {
  try {
    const action = isolationAction(
      globalThis.crossOriginIsolated,
      workerActive,
      sessionStorage.getItem(reloadGuard) !== null,
    );
    console.debug("[deckpress:coi] isolation check", {
      isolated: globalThis.crossOriginIsolated,
      workerActive,
      action,
    });
    if (action === "clear") sessionStorage.removeItem(reloadGuard);
    if (action === "reload") {
      sessionStorage.setItem(reloadGuard, "1");
      location.reload();
    }
  } catch {
    // Do not reload if session storage is blocked.
  }
}

export async function registerWebApp() {
  const serviceWorker = isSecureContext ? navigator.serviceWorker : undefined;
  const controlled = !!serviceWorker?.controller;
  recoverIsolation(controlled);
  if (!serviceWorker || controlled) return;

  const onControllerChange = () => recoverIsolation(!!serviceWorker.controller);
  serviceWorker.addEventListener("controllerchange", onControllerChange, {
    once: true,
  });
  try {
    const registration = await serviceWorker.register(
      new URL("coi-serviceworker.js", webAssetBase()),
    );
    if (registration.active?.state === "activated") {
      serviceWorker.removeEventListener("controllerchange", onControllerChange);
      recoverIsolation(true);
    }
  } catch (error) {
    serviceWorker.removeEventListener("controllerchange", onControllerChange);
    console.warn(
      "Offline caching and cross-origin isolation could not start",
      error,
    );
  }
}
