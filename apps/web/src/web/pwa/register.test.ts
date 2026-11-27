import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addReloadBlocker,
  isolationAction,
  notifyReloadCheck,
  RELOAD_IDLE_SETTLE_MS,
  registerWebApp,
  resetIsolationStateForTests,
  trackReloadWork,
} from "./register.ts";

class FakeServiceWorkerContainer extends EventTarget {
  controller: object | null = null;
  register = vi.fn<() => Promise<{ active?: { state: string } }>>();
}

function stubBrowser({
  isolated = false,
  controller = null,
  activeState,
}: {
  isolated?: boolean;
  controller?: object | null;
  activeState?: string;
} = {}) {
  const sw = new FakeServiceWorkerContainer();
  sw.controller = controller;
  sw.register.mockResolvedValue(
    activeState ? { active: { state: activeState } } : {},
  );
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("crossOriginIsolated", isolated);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: sw,
  });
  return sw;
}

let reload: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  reload = vi.fn();
  sessionStorage.clear();
  document.body.innerHTML = "";
  resetIsolationStateForTests(reload);
});

afterEach(() => {
  resetIsolationStateForTests();
  sessionStorage.clear();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it.each([
  [true, true, true, "clear"],
  [true, false, false, "clear"],
  [false, false, false, "none"],
  [false, true, false, "reload"],
  [false, true, true, "none"],
] as const)(
  "chooses an isolation action (isolated: %s, active worker: %s, attempted reload: %s)",
  (isolated, active, attempted, action) => {
    expect(isolationAction(isolated, active, attempted)).toBe(action);
  },
);

it("reloads immediately on first-visit activation when the app is idle", async () => {
  const sw = stubBrowser();
  await registerWebApp();
  expect(reload).not.toHaveBeenCalled();

  sw.controller = {};
  sw.dispatchEvent(new Event("controllerchange"));
  expect(reload).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem("deckpress-coi-reload")).toBe("1");
});

it("recovers isolation immediately after a hard reload when idle (#175)", async () => {
  stubBrowser({ controller: null, activeState: "activated" });
  await registerWebApp();
  expect(reload).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem("deckpress-coi-reload")).toBe("1");
});

it("defers the isolation reload while a dialog is open and reloads once it closes", async () => {
  vi.useFakeTimers();
  const sw = stubBrowser();
  await registerWebApp();

  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);

  sw.controller = {};
  sw.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();
  expect(dialog.isConnected).toBe(true);
  expect(dialog.hasAttribute("open")).toBe(true);

  await vi.advanceTimersByTimeAsync(RELOAD_IDLE_SETTLE_MS * 4);
  expect(reload).not.toHaveBeenCalled();

  dialog.removeAttribute("open");
  // Opening a follow-up dialog during the settle window keeps the reload deferred.
  await vi.advanceTimersByTimeAsync(RELOAD_IDLE_SETTLE_MS - 1);
  expect(reload).not.toHaveBeenCalled();
  const followup = document.createElement("dialog");
  followup.setAttribute("open", "");
  document.body.append(followup);
  await vi.advanceTimersByTimeAsync(RELOAD_IDLE_SETTLE_MS * 2);
  expect(reload).not.toHaveBeenCalled();

  followup.remove();
  await vi.advanceTimersByTimeAsync(RELOAD_IDLE_SETTLE_MS - 1);
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(reload).toHaveBeenCalledOnce();
});

it("defers the isolation reload during tracked uploads/restores and pending exports", async () => {
  vi.useFakeTimers();
  const sw = stubBrowser();
  await registerWebApp();

  let unsavedExport = true;
  const removeBlocker = addReloadBlocker(() => unsavedExport);
  let finishWork!: () => void;
  const work = trackReloadWork(
    new Promise<void>((resolve) => {
      finishWork = resolve;
    }),
  );

  sw.controller = {};
  sw.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();

  finishWork();
  await work;
  await vi.advanceTimersByTimeAsync(RELOAD_IDLE_SETTLE_MS * 2);
  expect(reload).not.toHaveBeenCalled();

  unsavedExport = false;
  notifyReloadCheck();
  await vi.advanceTimersByTimeAsync(RELOAD_IDLE_SETTLE_MS);
  expect(reload).toHaveBeenCalledOnce();
  removeBlocker();
});
