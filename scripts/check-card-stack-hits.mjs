// Start Chromium with --remote-debugging-port=9222 and a separate user data dir.
// Build and preview with VITE_TARGET=web, then run:
// node scripts/check-card-stack-hits.mjs http://localhost:4173/deckpress/ deck.json
// The deck backup must put Opt first and Ponder second in the same stack,
// with an in-strip English fallback badge on Ponder.
// Add --before to probe the previous instantaneous :hover raise.
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
  const statusBadge = card.querySelector(".card-status");
  const statusRect = rect(statusBadge);
  const status = center(statusRect);
  while (status[0] > Math.ceil(statusRect.left) && document.elementFromPoint(...status) !== statusBadge) {
    status[0]--;
  }
  const top = Math.round(frame.top + 14);
  const start = (x) => [Math.round(x), top];
  const make = (name, type, waypoints, expected = "Opt", dwell = false) => {
    const points = [waypoints[0]];
    for (let index = 1; index < waypoints.length; index++) {
      const from = waypoints[index - 1];
      const to = waypoints[index];
      const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 4);
      for (let i = 1; i <= steps; i++) {
        const point = from.map((start, axis) => Math.round(start + (to[axis] - start) * i / steps));
        if (point.some((value, axis) => value !== points.at(-1)[axis])) points.push(point);
      }
    }
    const samples = points.map((point) => {
      const element = document.elementFromPoint(...point);
      const owner = element?.closest(".playing-card");
      return {
        point,
        painted: owner?.ariaLabel?.replace("Choose art for ", "") ?? null,
        languageCrossing: owner !== card && !!element?.closest(".card-language"),
      };
    });
    if (samples.at(-1).painted !== expected) throw new Error(`${name}: unexpected painted target`);
    return { name, type, to:points.at(-1), expected, samples, dwell };
  };
  const strip = start(frame.left + 32);
  const language = next.querySelector(".card-language[data-in-stack-strip]");
  if (!language || language.textContent !== "English fallback") {
    throw new Error("Ponder must have an in-strip English fallback language badge");
  }
  const crossing = center(rect(language));
  const right = start(crossing[0]);
  const diagonal = start(Math.min(frame.right - 3, crossing[0] + 14));
  const quantity = center(badge(next, ".quantity"));
  const result = [
    make("status", "straight", [start(status[0]), status]),
    make("status from right", "diagonal", [diagonal, crossing, status]),
    make("status from right", "down-then-across", [right, [right[0], status[1]], status]),
    make("covered Ponder strip", "straight", [strip, [strip[0], Math.round(rect(next).top + 40)]]),
    make("Ponder copy", "straight", [start(quantity[0]), quantity], "Ponder"),
    make("Ponder language", "straight", [right, crossing], "Ponder"),
    make("Ponder language", "dwell", [right, crossing], "Ponder", true),
  ];
  for (const path of result.filter(({name}) => name === "status from right")) {
    if (!path.samples.some(({languageCrossing}) => languageCrossing)) {
      throw new Error(`${path.type} never intersects a promoted language badge`);
    }
  }
  return result;
}

export async function traceStackPointer(evaluate, points, travel) {
  await evaluate(([x, y]) => {
    const read = (x, y) => document.elementFromPoint(x, y)
      ?.closest(".playing-card")?.ariaLabel?.replace("Choose art for ", "") ?? null;
    const hits = { [`${x}:${y}`]: { card: read(x, y), languageCrossing: false } };
    const move = ({ clientX: x, clientY: y, target }) => {
      hits[`${x}:${y}`] = {
        card: read(x, y),
        languageCrossing:
          !!target.closest?.(".card-language[data-in-stack-strip]") &&
          target.closest(".playing-card")?.ariaLabel !== "Choose art for Opt",
      };
    };
    window.stackProbeFinish = () => {
      document.removeEventListener("pointermove", move, true);
      return hits;
    };
    document.addEventListener("pointermove", move, true);
  }, points[0]);
  await travel(points.slice(1));
  const hits = await evaluate(() => {
    const result = window.stackProbeFinish();
    delete window.stackProbeFinish;
    return result;
  });
  return points.map(([x, y]) => hits[`${x}:${y}`]);
}

export async function checkCardStackHits(driver, { widths, report, before = false }) {
  const { evaluate, move, click, tab, resize, trace } = driver;
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
    await delay(220);
    const point = await evaluate((selector) => {
      document.activeElement.blur();
      const card = document.querySelector(selector);
      card.removeAttribute("title");
      card.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const r = card.getBoundingClientRect();
      const point = [Math.round(r.left + r.width / 2), Math.round(r.top + 18)];
      if (!document.elementFromPoint(...point)?.closest(selector)) {
        throw new Error(`Opt's start is not visible: ${point}`);
      }
      return point;
    }, opt);
    if (state === "hover") await move(point);
    else {
      await tab();
      await evaluate((selector) => document.querySelector(selector).focus({ preventScroll: true }), opt);
    }
    await until(() => evaluate((selector, state, before) => {
      const card = document.querySelector(selector);
      return card.matches(state === "hover" ? (before ? ":hover" : ".raised") : ":focus-visible") &&
        getComputedStyle(card).transform === "matrix(1, 0, 0, 1, 0, -8)";
    }, opt, state, before));
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
        for (const { name, type } of cases) {
          await raise(state);
          const { to, expected, samples, dwell } = (await evaluate(paths, opt))
            .find((path) => path.name === name && path.type === type);
          let misses = 0;
          let firstMiss;
          const points = samples.map(({ point }) => point);
          await move(points[0]);
          const hits = await trace(points);
          let observed = 0;
          let crossings = 0;
          for (const [index, { point, painted }] of samples.entries()) {
            const sample = hits[index];
            if (!sample) continue;
            observed++;
            if (sample.languageCrossing) crossings++;
            const hit = sample.card;
            if (hit !== painted) {
              misses++;
              firstMiss ??= { point, painted, hit };
            }
          }
          const raised = () => evaluate((selector, before) => {
            const card = document.querySelector(selector);
            return card.parentElement.querySelector(before ? ".playing-card:hover" : ".playing-card.raised")
              ?.ariaLabel?.replace("Choose art for ", "") ?? null;
          }, opt, before);
          const beforeDwell = dwell ? await raised() : null;
          if (dwell) await delay(240);
          const afterDwell = dwell ? await raised() : null;
          const paintedAtClick = await evaluate(([x,y]) => document.elementFromPoint(x,y)
            ?.closest(".playing-card")?.ariaLabel?.replace("Choose art for ", "") ?? null, to);
          await click(to);
          let opened = null;
          try {
            await until(() => find(art));
            opened = await evaluate((selector) => document.querySelector(selector).textContent, art);
          } catch {
            // A click missing all cards is a failed path, too.
          }
          const dwellPassed = !dwell || (beforeDwell === "Opt" && afterDwell === "Ponder");
          const crossed = name !== "status from right" || crossings > 0;
          const passed = crossed && dwellPassed && opened === expected && opened === paintedAtClick && !misses;
          report({ before, width, sidebar, state, name, type, samples: samples.length, observed, crossings,
            misses, firstMiss, expected, paintedAtClick, opened, beforeDwell, afterDwell, passed });
          if (!passed) failures++;
          await editor();
        }
      }
    }
  }
  return failures;
}

async function runWeb(url, backupPath, before) {
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
      trace: (points) => traceStackPointer(evaluate, points, async (rest) => {
        const dispatched = [];
        for (const point of rest) {
          dispatched.push(mouse("mouseMoved", point));
          await delay(8);
        }
        await Promise.all(dispatched);
      }),
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
    }, { widths: [1440, 1024, 768], before, report: (row) => console.log(JSON.stringify(row)) })) && !before ? 1 : 0;
  } finally {
    await send("Network.setBypassServiceWorker", { bypass: false });
    await send("Emulation.clearDeviceMetricsOverride");
    socket.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , url, backup] = process.argv;
  if (!url || !backup) throw new Error("Usage: node scripts/check-card-stack-hits.mjs <preview URL> <deck backup>");
  await runWeb(url, backup, process.argv.includes("--before"));
}
