import { webAssetBase } from "../asset-base.ts";

const reloadGuard = "deckpress-coi-reload";
export const RELOAD_IDLE_SETTLE_MS = 250;

export function isolationAction(
  isolated: boolean,
  workerActive: boolean,
  reloadAttempted: boolean,
) {
  if (isolated) return "clear";
  if (workerActive && !reloadAttempted) return "reload";
  return "none";
}

const blockers = new Set<() => boolean>();
let activeWork = 0;
let reloadPending = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let observer: MutationObserver | undefined;
let reloadPage = () => location.reload();

function hasOpenDialog() {
  if (typeof document === "undefined") return false;
  return (
    document.querySelector(
      'dialog[open], [role="dialog"], [role="alertdialog"]',
    ) !== null
  );
}

export function isIsolationReloadBlocked() {
  if (activeWork > 0 || hasOpenDialog()) return true;
  for (const blocked of blockers) {
    if (blocked()) return true;
  }
  return false;
}

function clearSettleTimer() {
  if (settleTimer !== undefined) {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }
}

function stopWatching() {
  clearSettleTimer();
  observer?.disconnect();
  observer = undefined;
}

function startWatching() {
  if (
    observer ||
    typeof MutationObserver === "undefined" ||
    typeof document === "undefined" ||
    !document.documentElement
  )
    return;
  observer = new MutationObserver(() => notifyReloadCheck());
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open", "role"],
  });
}

function tryPerformReload(deferIfBlocked: boolean) {
  try {
    const action = isolationAction(
      globalThis.crossOriginIsolated,
      true,
      sessionStorage.getItem(reloadGuard) !== null,
    );
    if (action === "clear") {
      reloadPending = false;
      stopWatching();
      sessionStorage.removeItem(reloadGuard);
      return;
    }
    if (action !== "reload") {
      reloadPending = false;
      stopWatching();
      return;
    }
    if (isIsolationReloadBlocked()) {
      if (deferIfBlocked) {
        reloadPending = true;
        clearSettleTimer();
        startWatching();
        console.debug("[deckpress:coi] deferring reload until idle");
      }
      return;
    }
    reloadPending = false;
    stopWatching();
    sessionStorage.setItem(reloadGuard, "1");
    reloadPage();
  } catch {
    // Do not reload if session storage is blocked.
    reloadPending = false;
    stopWatching();
  }
}

export function notifyReloadCheck() {
  if (!reloadPending) return;
  if (isIsolationReloadBlocked()) {
    clearSettleTimer();
    return;
  }
  clearSettleTimer();
  settleTimer = setTimeout(() => {
    settleTimer = undefined;
    if (!reloadPending) return;
    tryPerformReload(true);
  }, RELOAD_IDLE_SETTLE_MS);
}

export function addReloadBlocker(isBlocked: () => boolean) {
  blockers.add(isBlocked);
  if (isBlocked()) clearSettleTimer();
  return () => {
    blockers.delete(isBlocked);
    notifyReloadCheck();
  };
}

export async function trackReloadWork<T>(work: Promise<T>): Promise<T> {
  activeWork++;
  clearSettleTimer();
  try {
    return await work;
  } finally {
    activeWork = Math.max(0, activeWork - 1);
    notifyReloadCheck();
  }
}

export function resetIsolationStateForTests(reload = () => location.reload()) {
  reloadPending = false;
  activeWork = 0;
  blockers.clear();
  stopWatching();
  reloadPage = reload;
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
      blocked: isIsolationReloadBlocked(),
    });
    if (action === "clear") {
      reloadPending = false;
      stopWatching();
      sessionStorage.removeItem(reloadGuard);
    }
    if (action === "reload") tryPerformReload(true);
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
