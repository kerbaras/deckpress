/*! Adapted from coi-serviceworker v0.1.7 (https://github.com/gzuidhof/coi-serviceworker).
 *  Guido Zuidhof and contributors, licensed under MIT. See coi-serviceworker.LICENSE.
 */

const shellCache = "deckpress-upscale-demo-v1";
const scope = self.registration.scope;
const models = new URL("models/", scope).href;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

function isolate(response) {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function load(event) {
  const request = event.request;
  const cache = await caches.open(shellCache).catch(() => undefined);
  const key = new URL(request.url);
  if (key.pathname.endsWith("/ort/ort.webgpu.min.mjs")) key.search = "";
  try {
    const response = await fetch(request);
    if (cache && response.ok && response.status !== 206) {
      event.waitUntil(cache.put(key.href, response.clone()).catch(() => {}));
    }
    return isolate(response);
  } catch (error) {
    const cached = await cache?.match(key.href);
    if (cached) return isolate(cached);
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (
    request.method !== "GET" ||
    (request.cache === "only-if-cached" && request.mode !== "same-origin") ||
    !request.url.startsWith(scope) ||
    request.url.startsWith(models)
  )
    return;
  event.respondWith(load(event));
});
