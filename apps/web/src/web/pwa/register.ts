import { webAssetBase } from "../asset-base.ts";

export async function registerWebApp() {
  if (!isSecureContext || !navigator.serviceWorker) return;
  const serviceWorker = navigator.serviceWorker;
  if (serviceWorker.controller) return;
  const reload = () => location.reload();
  serviceWorker.addEventListener("controllerchange", reload, { once: true });
  try {
    await serviceWorker.register(
      new URL("coi-serviceworker.js", webAssetBase()),
    );
  } catch (error) {
    serviceWorker.removeEventListener("controllerchange", reload);
    console.warn(
      "Offline caching and cross-origin isolation could not start",
      error,
    );
  }
}
