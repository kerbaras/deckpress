# Deckpress

- Use the pinned pnpm version and Node 24 LTS. Run `pnpm check` from the root for lint, typechecks, tests, and production builds. Focus tests with `pnpm test --project web`, `api`, or `core`.
- Keep `@deckpress/core` browser-safe. Both apps consume it through `workspace:*`, not relative imports across packages.
- Development and tests resolve core source through the `@deckpress/source` export condition. Production Node builds resolve `dist`; `pnpm build` builds core before the apps. Preserve both paths when changing package exports.
- The API uses Node's native TypeScript support in development. Use erasable syntax and explicit `.ts` extensions for relative imports; TypeScript rewrites those extensions when building.
- Keep the Hono app separate from its server entry point so tests can call `app.request` without opening sockets.
- Assume development servers are already running. Start or restart them only when asked.
- The web client calls same-origin `/api` paths. Vite proxies these to the API in development. Production hosting must serve `apps/web/dist`, fall back to `index.html` for SPA routes, and route `/api` to the API. `pnpm start` starts only the built API.
- This PoC is single-user and local-only. Keep the API on loopback. SQLite, image caches, uploads, and PDF jobs live under `apps/api/data` unless `DECKPRESS_DATA_DIR` overrides it. Deck JSON backups reference uploads rather than embedding them.
- `pnpm test:e2e` uses installed Google Chrome and already-running servers at `http://localhost:5173` (override with `DECKPRESS_TEST_URL`). It exercises live Scryfall/MPC calls and saves PDF/screenshot attachments under `test-results`.
- Print preview and export share core geometry and the API rasterizer. Preview uses 150 DPI without AI; final export applies the requested DPI and optional local upscaling. Keep physical card dimensions independent of raster resolution.
- Art ratings, favorites, labels, and popularity are local user data. Only Scryfall has verified official provenance; MPC creator names identify source drives, not necessarily artists.
