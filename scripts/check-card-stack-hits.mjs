// Start Chromium with --remote-debugging-port=9222 and a separate user data dir.
// Build and preview with VITE_TARGET=web, then run:
// DECKPRESS_STACK_FIXTURE=long-language node scripts/check-card-stack-hits.mjs http://localhost:4173/deckpress/
// The default fixture is "engineer"; an explicit deck backup path overrides it.
// Playwright must be installed for the web runner (NODE_PATH may point to an external node_modules).
// The deck backup must put Opt first and Ponder second in the same stack,
// with an in-strip English fallback badge on Ponder.
// Add --before to probe the previous instantaneous :hover raise.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const art = ".art-studio .studio-toolbar h2";
const opt = '.card-stack > [aria-label="Choose art for Opt"]';

export function stackFixturePath(fixture = process.env.DECKPRESS_STACK_FIXTURE ?? "engineer") {
  if (fixture !== "engineer" && fixture !== "long-language") {
    throw new Error(`Unknown stack fixture: ${fixture} (expected engineer or long-language)`);
  }
  return fileURLToPath(new URL(`check-card-stack-hits.${fixture}.json`, import.meta.url));
}

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

export async function checkCardStackHits(driver, { widths, report, before = false, verifyLongBadges = false }) {
  const { evaluate, tab, resize } = driver;
  const outside = [2, 2];
  let pointer = outside;
  const move = async (point) => {
    await driver.move(point);
    pointer = point;
  };
  const click = async (point) => {
    await driver.click(point);
    pointer = point;
  };
  const trace = async (points) => {
    const hits = await driver.trace(points);
    pointer = points.at(-1);
    return hits;
  };
  async function moveOffStack() {
    const from = pointer;
    for (let step = 1; step <= 6; step++) {
      const point = from.map((value, axis) =>
        Math.round(value + (outside[axis] - value) * step / 6));
      if (step === 6 || point.some((value, axis) => value !== pointer[axis])) await move(point);
    }
  }
  const find = (selector) => evaluate((s) => !!document.querySelector(s), selector);
  const editor = async () => {
    if (await find(art)) {
      const back = await evaluate(() => {
        const tab = document.querySelector('.workspace-views [title="Deck editor"]');
        const { x, y, width, height } = tab.getBoundingClientRect();
        return [Math.round(x + width / 2), Math.round(y + height / 2)];
      });
      await move(back);
      await click(back);
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

  async function resetRaise() {
    await evaluate(() => document.activeElement.blur());
    await moveOffStack();
    await delay(380);
    if (!before && await find(".card-stack > .playing-card.raised")) {
      throw new Error("Expected no raised card after resetting focus and pointer");
    }
  }

  async function raise(state) {
    await resetRaise();
    const point = await evaluate((selector) => {
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
      return card.matches(before ? (state === "hover" ? ":hover" : ":focus-visible") : ".raised") &&
        (state !== "focus" || card.matches(":focus-visible")) &&
        getComputedStyle(card).transform === "matrix(1, 0, 0, 1, 0, -8)";
    }, opt, state, before));
  }

  const stackState = () => evaluate((selector) => {
    const opt = document.querySelector(selector);
    const cards = [...opt.parentElement.children];
    const name = (card) => card.ariaLabel.replace("Choose art for ", "");
    const style = getComputedStyle(opt);
    return {
      raised: cards.filter(card => card.matches(".raised")).map(name),
      lifted: cards.filter(card => getComputedStyle(card).transform !== "none").map(name),
      optFocusRing: opt === document.activeElement && opt.matches(":focus-visible") &&
        style.outlineStyle === "solid" && parseFloat(style.outlineWidth) > 0,
    };
  }, opt);
  const onlyRaised = (state, id) =>
    state.raised.join() === id && state.lifted.join() === id;
  async function settledStackState() {
    await evaluate(async (selector) => {
      const stack = document.querySelector(selector).parentElement;
      const lifts = stack.getAnimations({ subtree: true })
        .filter(animation => animation.transitionProperty === "transform");
      await Promise.allSettled(lifts.map(animation => animation.finished));
    }, opt);
    return stackState();
  }

  let failures = 0;
  let wrappedBadges = 0;
  for (const width of widths) {
    await resize(width);
    for (const sidebar of ["open", "closed"]) {
      await evaluate((desired) => {
        if (document.querySelector(".app-shell").dataset.sidebar === desired) return;
        const label = desired === "open" ? "Show sidebar" : "Hide sidebar";
        document.querySelector(`[aria-label="${label}"]`).click();
      }, sidebar);
      await until(() => evaluate((desired) => document.querySelector(".app-shell").dataset.sidebar === desired, sidebar));
      if (verifyLongBadges) {
        const { total, fallback, wrapped } = await evaluate(() => {
          const badges = [...document.querySelectorAll(".card-stack .card-language")];
          const fallback = badges.filter(badge => badge.textContent === "English fallback");
          const wrapped = fallback.filter(badge => {
            const text = document.createRange();
            text.selectNodeContents(badge);
            return text.getClientRects().length > 1;
          });
          return { total: badges.length, fallback: fallback.length, wrapped: wrapped.length };
        });
        if (fallback <= total / 2) throw new Error("Expected most stack badges to show English fallback");
        wrappedBadges += wrapped;
        console.error(`Long-language badges at ${width}px, sidebar ${sidebar}: ${fallback}/${total} fallback, ${wrapped} wrapped`);
      }
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
      if (!before) {
        await raise("focus");
        const focused = await stackState();
        const { to } = (await evaluate(paths, opt))
          .find(path => path.type === "dwell");
        await move(to);
        await delay(380);
        const handoff = await settledStackState();
        await moveOffStack();
        await delay(380);
        const restored = await settledStackState();
        const passed = onlyRaised(focused, "Opt") && focused.optFocusRing &&
          onlyRaised(handoff, "Ponder") && handoff.optFocusRing &&
          onlyRaised(restored, "Opt") && restored.optFocusRing;
        report({ width, sidebar, type: "focus+hover", focused, handoff, restored, passed });
        if (!passed) failures++;

        for (const type of ["blur", "hidden"]) {
          await raise("hover");
          const initial = await stackState();
          await evaluate((type) => {
            if (type === "blur") {
              window.dispatchEvent(new Event("blur"));
              return;
            }
            const descriptor = Object.getOwnPropertyDescriptor(document, "hidden");
            Object.defineProperty(document, "hidden", { configurable: true, value: true });
            try {
              document.dispatchEvent(new Event("visibilitychange"));
            } finally {
              if (descriptor) Object.defineProperty(document, "hidden", descriptor);
              else delete document.hidden;
            }
          }, type);
          await delay(380);
          const cleared = await stackState();
          const passed = onlyRaised(initial, "Opt") && onlyRaised(cleared, "");
          report({ width, sidebar, type, initial, cleared, passed });
          if (!passed) failures++;
        }
      }
    }
  }
  if (verifyLongBadges && !wrappedBadges) throw new Error("Expected a wrapped English fallback badge");
  return failures;
}

async function runWeb(url, backupPath, before) {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const debug = process.env.CHROME_DEBUG_URL ?? "http://127.0.0.1:9222";
  const browser = await chromium.connectOverCDP(debug);
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      const evaluate = (fn, ...args) =>
        page.evaluate(`(${fn})(...${JSON.stringify(args)})`);
      await page.goto(url);
      const html = await (await fetch(url)).text();
      const stylesheet = html.match(/href="([^"]+\.css)"/)?.[1];
      if (!stylesheet) throw new Error("Expected a production build stylesheet");
      await page.waitForFunction((href) =>
        crossOriginIsolated && !!document.querySelector(`link[href="${href}"]`), stylesheet, { timeout: 10_000 });
      await page.locator('input[accept=".json"]').setInputFiles(backupPath);
      await until(() => evaluate(() => !!document.querySelector(".playing-card")));

      const failures = await checkCardStackHits({
        evaluate,
        move: ([x, y]) => page.mouse.move(x, y),
        trace: (points) => traceStackPointer(evaluate, points, async (rest) => {
          const dispatched = [];
          const start = performance.now();
          for (const [index, [x, y]] of rest.entries()) {
            const remaining = start + index * 8 - performance.now();
            if (remaining > 0) await delay(remaining);
            dispatched.push(session.send("Input.dispatchMouseEvent", {
              type: "mouseMoved", x, y,
            }));
          }
          await Promise.all(dispatched);
        }),
        click: ([x, y]) => page.mouse.click(x, y),
        tab: () => page.keyboard.press("Tab"),
        resize: (width) => page.setViewportSize({ width, height: 1100 }),
      }, {
        widths: [1440, 1024, 768],
        before,
        verifyLongBadges: backupPath === stackFixturePath("long-language"),
        report: (row) => console.log(JSON.stringify(row)),
      });
      process.exitCode = failures && !before ? 1 : 0;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , url, ...args] = process.argv;
  if (!url) throw new Error("Usage: node scripts/check-card-stack-hits.mjs <preview URL> [deck backup] [--before]");
  const backup = args.find(arg => arg !== "--before") ?? stackFixturePath();
  await runWeb(url, backup, args.includes("--before"));
}
