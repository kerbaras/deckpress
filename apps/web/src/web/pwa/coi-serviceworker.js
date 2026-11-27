/*! Adapted from coi-serviceworker v0.1.7 (https://github.com/gzuidhof/coi-serviceworker).
 *  Guido Zuidhof and contributors, licensed under MIT. See coi-serviceworker.LICENSE.
 */

// stage-pages.ts inserts the content version and shell file list here.
const build = /* BUILD */ { version: "dev", files: [] };
const scope = self.registration.scope;
const shellPrefix = `deckpress-web-shell-${scope}-`;
const shellCache = shellPrefix + build.version;
const artCache = "deckpress-web-art-v1";
const models = new URL("models/", scope).href;
const scryfallImages = [
  "https://cards.scryfall.io/",
  "https://svgs.scryfall.io/sets/",
];

self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(shellCache)
      .then((cache) =>
        cache.addAll(
          build.files.map(
            (file) => new Request(new URL(file, scope), { cache: "reload" }),
          ),
        ),
      ),
  ),
);

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith(shellPrefix) && key !== shellCache)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);

function isolate(response) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cachedFetch(request, cacheName, key = request) {
  const cache = await caches.open(cacheName).catch(() => undefined);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.status !== 206)
    await cache?.put(key, response.clone()).catch(() => {});
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (
    request.method !== "GET" ||
    request.headers.has("range") ||
    (request.cache === "only-if-cached" && request.mode !== "same-origin")
  )
    return;

  if (
    scryfallImages.some((prefix) => request.url.startsWith(prefix)) &&
    request.destination === "image" &&
    request.mode === "cors"
  ) {
    event.respondWith(cachedFetch(request, artCache));
  } else if (request.url.startsWith(scope) && !request.url.startsWith(models)) {
    const url = new URL(request.url);
    // ORT uses separate module instances for backends with different settings.
    if (url.pathname.endsWith("/ort/ort.webgpu.min.mjs")) url.search = "";
    const key =
      request.mode === "navigate"
        ? new URL("index.html", scope).href
        : url.href;
    event.respondWith(cachedFetch(request, shellCache, key).then(isolate));
  }
});
