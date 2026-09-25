import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artPreferenceSchema,
  artSchema,
  deckSchema,
  type HealthResponse,
  jobSchema,
  printSettingsSchema,
} from "@deckpress/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import sharp from "sharp";
import { z } from "zod";
import { AppError } from "./errors.ts";
import { Images, uploadSchema } from "./images.ts";
import { Jobs } from "./jobs.ts";
import { rasterize } from "./pdf.ts";
import { Providers } from "./providers.ts";
import { Store } from "./store.ts";
import { Upscaler } from "./upscaler.ts";

const preferenceSchema = artPreferenceSchema.extend({ id: z.string() });
const createDeckSchema = deckSchema
  .pick({
    name: true,
    format: true,
    notes: true,
    entries: true,
    printSettings: true,
    coverEntryId: true,
  })
  .extend({
    entries: deckSchema.shape.entries.default([]),
    printSettings: printSettingsSchema.prefault({}),
  });

export function createApp(
  options: { dataDir?: string; store?: Store; providers?: Providers } = {},
) {
  const root =
    options.dataDir ??
    process.env.DECKPRESS_DATA_DIR ??
    fileURLToPath(new URL("../data", import.meta.url));
  const store = options.store ?? new Store(join(root, "deckpress.sqlite"));
  const providers = options.providers ?? new Providers(store);
  const images = new Images(root, store);
  const upscaler = new Upscaler(root);
  const jobs = new Jobs(store, images, upscaler, root);
  const app = new Hono();
  app.use("*", requestId(), secureHeaders());
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 17 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request exceeds 17 MB" }, 413),
    }),
  );
  app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (
        c.req.header("sec-fetch-site") === "cross-site" ||
        (origin &&
          !["localhost", "127.0.0.1", "[::1]"].includes(
            new URL(origin).hostname,
          ))
      )
        return c.json(
          { error: "Deckpress only accepts local application requests" },
          403,
        );
      if (
        c.req.path !== "/api/uploads" &&
        !c.req.header("content-type")?.startsWith("application/json")
      )
        return c.json({ error: "Use application/json" }, 400);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      service: "@deckpress/api",
    } satisfies HealthResponse),
  );
  app.get("/api/settings", async (c) =>
    c.json({
      upscaler: await upscaler.status(),
      storage: "Local SQLite",
      localOnly: true,
    }),
  );
  app.get("/api/decks", (c) => c.json(store.list("deck", deckSchema)));
  app.post("/api/decks", async (c) =>
    c.json(store.createDeck(createDeckSchema.parse(await c.req.json())), 201),
  );
  app.get("/api/decks/:id", (c) => {
    const deck = store.get(
      "deck",
      z.uuid().parse(c.req.param("id")),
      deckSchema,
    );
    if (!deck) throw new AppError("Deck not found", 404);
    return c.json(deck);
  });
  app.put("/api/decks/:id", async (c) => {
    const deck = deckSchema.parse(await c.req.json());
    if (deck.id !== c.req.param("id")) throw new AppError("Deck ID mismatch");
    return c.json(store.updateDeck(deck));
  });
  app.delete("/api/decks/:id", (c) => {
    store.removeDeck(z.uuid().parse(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.post("/api/import", async (c) => {
    const input = z
      .object({
        text: z.string().max(200_000).default(""),
        url: z.string().max(2048).optional(),
      })
      .parse(await c.req.json());
    const text = input.url ? await providers.importUrl(input.url) : input.text;
    return c.json(await providers.resolve(text));
  });
  app.get("/api/art", async (c) => {
    const input = z
      .object({
        provider: z.enum(["scryfall", "mpc"]),
        oracleId: z.uuid(),
        name: z.string().min(1).max(300),
        page: z.coerce.number().int().min(1).max(100).default(1),
        face: z.coerce.number().int().min(0).max(1).default(0),
      })
      .parse(c.req.query());
    return c.json(
      input.provider === "scryfall"
        ? await providers.prints(input.oracleId, input.page, input.face)
        : await providers.community(input.name, input.page),
    );
  });
  app.get("/api/preferences", (c) => {
    const usage: Record<string, number> = {};
    for (const deck of store.list("deck", deckSchema))
      for (const entry of deck.entries) {
        const id = (entry.selectedArt ?? entry.card.faces[0])?.id;
        if (id) usage[id] = (usage[id] ?? 0) + entry.quantity;
      }
    return c.json({
      preferences: Object.fromEntries(
        store
          .list("preference", preferenceSchema)
          .map(({ id, ...pref }) => [id, pref]),
      ),
      usage,
    });
  });
  app.put("/api/preferences/:id", async (c) => {
    const id = z.string().min(1).max(160).parse(c.req.param("id"));
    const preference = artPreferenceSchema.parse(await c.req.json());
    store.put("preference", id, { id, ...preference });
    return c.json(preference);
  });
  app.get("/api/uploads", (c) =>
    c.json(
      store
        .list("upload", uploadSchema)
        .filter((value) => value.oracleId === c.req.query("oracleId"))
        .map((value) => value.art),
    ),
  );
  app.post("/api/uploads", async (c) => {
    const data = await c.req.formData();
    const file = data.get("image");
    if (!(file instanceof File)) throw new AppError("Select an image file");
    const input = z
      .object({
        oracleId: z.uuid(),
        name: z.string().min(1).max(300),
        artist: z.string().max(200),
        bleedMm: z.coerce.number().min(0).max(10),
      })
      .parse({
        oracleId: data.get("oracleId"),
        name: data.get("name"),
        artist: data.get("artist") ?? "",
        bleedMm: data.get("bleedMm") ?? 0,
      });
    return c.json(
      await images.upload(new Uint8Array(await file.arrayBuffer()), input),
      201,
    );
  });
  const imageResponse = async (url: string) => {
    const bytes = await images.read(url);
    const metadata = await sharp(bytes).metadata();
    const type =
      metadata.format === "jpeg"
        ? "image/jpeg"
        : metadata.format === "webp"
          ? "image/webp"
          : "image/png";
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, max-age=86400",
      },
    });
  };
  app.get("/api/preview", async (c) => {
    const input = z
      .object({ art: z.string().max(12000), settings: z.string().max(6000) })
      .parse(c.req.query());
    const art = artSchema.parse(JSON.parse(input.art));
    const settings = printSettingsSchema.parse({
      ...z.record(z.string(), z.unknown()).parse(JSON.parse(input.settings)),
      dpi: 150,
      upscale: false,
    });
    const bytes = await rasterize(
      await images.read(art.imageUrl),
      art,
      settings,
      upscaler,
      c.req.raw.signal,
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=86400",
      },
    });
  });
  app.get("/api/image", (c) =>
    imageResponse(z.string().min(1).max(2048).parse(c.req.query("url"))),
  );
  app.get("/api/uploads/:id", (c) =>
    imageResponse(`/api/uploads/${z.uuid().parse(c.req.param("id"))}`),
  );
  app.get("/api/jobs", (c) => c.json(store.list("job", jobSchema)));
  app.post("/api/jobs", async (c) => {
    const input = z
      .object({ deckId: z.uuid(), settings: printSettingsSchema })
      .parse(await c.req.json());
    const deck = store.get("deck", input.deckId, deckSchema);
    if (!deck) throw new AppError("Deck not found", 404);
    if (input.settings.upscale && !(await upscaler.status()).available)
      throw new AppError("Local AI upscaler is not configured", 503);
    return c.json(jobs.create(deck, input.settings), 202);
  });
  app.post("/api/jobs/:id/cancel", (c) => {
    jobs.cancel(z.uuid().parse(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.get("/api/jobs/:id/download", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    const job = store.get("job", id, jobSchema);
    if (job?.status !== "completed")
      throw new AppError("PDF is not ready", 404);
    const bytes = await readFile(join(root, "jobs", `${id}.pdf`));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${job.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    if (error instanceof AppError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: error.issues
            .map(
              (issue) => `${issue.path.join(".") || "Input"}: ${issue.message}`,
            )
            .join("; "),
        },
        400,
      );
    if (error instanceof SyntaxError)
      return c.json({ error: "Invalid JSON" }, 400);
    console.error(error);
    return c.json(
      { error: "Request failed. Check the API output and try again." },
      500,
    );
  });
  return {
    app,
    store,
    images,
    jobs,
    upscaler,
    close: async () => {
      await jobs.close();
      store.close();
    },
  };
}
