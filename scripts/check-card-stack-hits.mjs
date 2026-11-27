// Start Chromium with --remote-debugging-port=9222 and a separate user data dir.
// Build and preview with VITE_TARGET=web, then run:
// node scripts/check-card-stack-hits.mjs http://localhost:4173/deckpress/ deck.json
// The deck backup must put Opt first and Ponder second in the same stack.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const art = ".art-studio .studio-toolbar h2";
const opt = '.card-stack > [aria-label="Choose art for Opt"]';

async function until(read) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await read()) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for Deckpress");
}

function paths(selector) {
  const card = document.querySelector(selector);
  const next = card.nextElementSibling;
  if (next?.ariaLabel !== "Choose art for Ponder") {
    throw new Error("Expected Ponder immediately after Opt");
  }
  const rect = (element) => element.getBoundingClientRect();
  const center = (r) => [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  const badge = (card, name) => rect(card.querySelector(name));
  const frame = rect(card);
  const status = center(badge(card, ".card-status"));
  const top = Math.round(frame.top + 14);
  const start = (x) => [Math.round(x), top];
  const make = (name, type, from, to, expected = "Opt", overlay = null) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2));
    let painted = "Opt";
    const samples = Array.from({ length: steps + 1 }, (_, i) => {
      const point = from.map((start, axis) => Math.round(start + (to[axis] - start) * i / steps));
      if (overlay && document.elementsFromPoint(...point).includes(overlay)) painted = expected;
      return { point, painted };
    });
    return { name, type, to, expected, samples };
  };
  const middle = start(frame.left + frame.width / 2);
  const right = start(frame.right - 18);
  const result = [
    make("status", "straight", start(status[0]), status),
    make("status from center", "diagonal", middle, status),
    make("status from right", "diagonal", right, status),
    make("covered Ponder strip", "straight", middle, [middle[0], Math.round(rect(next).top + 30)]),
  ];
  for (const badgeName of [".quantity", ".card-language"]) {
    const own = center(badge(card, badgeName));
    const overlay = next.querySelector(badgeName);
    const neighbor = rect(overlay);
    const target = center(neighbor);
    if (badgeName === ".card-language" && neighbor.bottom > rect(next).top + 43) {
      throw new Error("The probe fixture requires Ponder's language label to fit in its strip");
    }
    result.push(
      make(`Opt ${badgeName}`, "straight", start(own[0]), own),
      make(`Opt ${badgeName}`, "diagonal", middle, own),
      make(`Ponder ${badgeName}`, "straight", start(target[0]), target, "Ponder", overlay),
      make(`Ponder ${badgeName}`, "diagonal", middle, target, "Ponder", overlay),
    );
  }
  return result;
}

export async function checkCardStackHits(driver, { widths, report, before = false }) {
  const { evaluate, move, click, tab, resize } = driver;
  const trace = async (points) => {
    const hits = [];
    for (const point of points) {
      await move(point);
      hits.push(await evaluate((x, y) => document.elementFromPoint(x, y)
        ?.closest(".playing-card")?.ariaLabel?.replace("Choose art for ", "") ?? null, ...point));
    }
    return hits;
  };
  const find = (selector) => evaluate((s) => !!document.querySelector(s), selector);
  const editor = async () => {
    if (await find(art)) {
      await evaluate(() => document.querySelector('.workspace-views [title="Deck editor"]').click());
      await until(() => find(opt));
    }
  };
  await editor();
  await evaluate(() => document.querySelector('[aria-label="Edit card quantities"]').click());
  await evaluate(() => {
    const print = document.querySelector('[aria-label="Print Opt"]');
    if (print.checked) print.click();
    document.querySelector('[aria-label="Stacks view"]').click();
  });
  await until(() => find(`${opt}.excluded > .card-status`));

  async function raise(state) {
    await move([2, 2]);
    const point = await evaluate((selector) => {
      document.activeElement.blur();
      const card = document.querySelector(selector);
      card.removeAttribute("title");
      document.querySelector(".card-groups").scrollIntoView({ block: "center" });
      const r = card.getBoundingClientRect();
      return [Math.round(r.left + r.width / 2), Math.round(r.top + 18)];
    }, opt);
    if (state === "hover") await move(point);
    else {
      await tab();
      await evaluate((selector) => document.querySelector(selector).focus({ preventScroll: true }), opt);
    }
    await until(() => evaluate((selector, state) => {
      const card = document.querySelector(selector);
      return card.matches(state === "hover" ? ":hover" : ":focus-visible") &&
        getComputedStyle(card).transform === "matrix(1, 0, 0, 1, 0, -8)";
    }, opt, state));
  }

  let failures = 0;
  for (const width of widths) {
    await resize(width);
    for (const sidebar of ["open", "closed"]) {
      await evaluate((desired) => {
        if (document.querySelector(".app-shell").dataset.sidebar === desired) return;
        const label = desired === "open" ? "Show sidebar" : "Hide sidebar";
        document.querySelector(`[aria-label="${label}"]`).click();
      }, sidebar);
      await until(() => evaluate((desired) => document.querySelector(".app-shell").dataset.sidebar === desired, sidebar));
      for (const state of ["hover", "focus"]) {
        await raise(state);
        const cases = await evaluate(paths, opt);
        for (const { name, type, to, expected, samples } of cases) {
          await raise(state);
          let misses = 0;
          let firstMiss;
          const points = samples.map(({ point }) => point);
          let hits = await (driver.trace ?? trace)(points);
          if (hits.includes(undefined)) {
            await raise(state);
            hits = await trace(points);
          }
          for (const [index, { point, painted }] of samples.entries()) {
            const hit = hits[index];
            if (hit !== painted) {
              misses++;
              firstMiss ??= { point, painted, hit };
            }
          }
          await click(to);
          let opened = null;
          try {
            await until(() => find(art));
            opened = await evaluate((selector) => document.querySelector(selector).textContent, art);
          } catch {
            // A click missing all cards is a failed path, too.
          }
          report({ before, width, sidebar, state, name, type, samples: samples.length, misses, firstMiss, expected, opened });
          if (misses || opened !== expected) failures++;
          await editor();
        }
      }
    }
  }
  return failures;
}

async function runWeb(url, backupPath) {
  const backup = await readFile(backupPath, "utf8");
  const debug = process.env.CHROME_DEBUG_URL ?? "http://127.0.0.1:9222";
  const targets = await (await fetch(`${debug}/json/list`)).json();
  const target = targets.find((page) => page.url.split("#")[0] === url) ??
    await (await fetch(`${debug}/json/new?about:blank`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++id;
    pending.set(request, { resolve, reject });
    socket.send(JSON.stringify({ id: request, method, params }));
  });
  const evaluate = async (fn, ...args) => {
    const result = await send("Runtime.evaluate", {
      expression: `(${fn})(...${JSON.stringify(args)})`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.result.description);
    return result.result.value;
  };
  const mouse = (type, [x, y]) => send("Input.dispatchMouseEvent", {
    type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1,
  });
  try {
    await send("Page.bringToFront");
    const html = await (await fetch(url)).text();
    const stylesheet = html.match(/href="([^"]+\.css)"/)?.[1];
    if (!stylesheet) throw new Error("Expected a production build stylesheet");
    await send("Network.setBypassServiceWorker", { bypass: true });
    await send("Page.navigate", { url });
    await until(() => evaluate((href) =>
      crossOriginIsolated && !!document.querySelector(`link[href="${href}"]`), stylesheet));
    await until(() => evaluate(() => !!document.querySelector('.playing-card, .art-studio, input[accept=".json"]')));
    if (!(await evaluate(() => !!document.querySelector(".playing-card, .art-studio")))) {
      await evaluate((content) => {
        const input = document.querySelector('input[accept=".json"]');
        const transfer = new DataTransfer();
        transfer.items.add(new File([content], "deck.json", { type: "application/json" }));
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, backup);
      await until(() => evaluate(() => !!document.querySelector(".playing-card")));
    }
    process.exitCode = (await checkCardStackHits({
      evaluate,
      move: (point) => mouse("mouseMoved", point),
      click: async (point) => {
        await mouse("mousePressed", point);
        await mouse("mouseReleased", point);
      },
      tab: async () => {
        for (const type of ["keyDown", "keyUp"]) {
          await send("Input.dispatchKeyEvent", { type, key: "Tab", windowsVirtualKeyCode: 9 });
        }
      },
      resize: (width) => send("Emulation.setDeviceMetricsOverride", {
        width, height: 1100, deviceScaleFactor: 1, mobile: false,
      }),
    }, { widths: [1440, 1024, 768], report: (row) => console.log(JSON.stringify(row)) })) ? 1 : 0;
  } finally {
    await send("Network.setBypassServiceWorker", { bypass: false });
    await send("Emulation.clearDeviceMetricsOverride");
    socket.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , url, backup] = process.argv;
  if (!url || !backup) throw new Error("Usage: node scripts/check-card-stack-hits.mjs <preview URL> <deck backup>");
  await runWeb(url, backup);
}
