export async function installIsolation(base: URL) {
  if (!isSecureContext || !navigator.serviceWorker) return;
  const serviceWorker = navigator.serviceWorker;
  if (serviceWorker.controller) return;

  const reload = () => location.reload();
  serviceWorker.addEventListener("controllerchange", reload, { once: true });
  try {
    await serviceWorker.register(new URL("coi-serviceworker.js", base));
  } catch {
    serviceWorker.removeEventListener("controllerchange", reload);
  }
}
