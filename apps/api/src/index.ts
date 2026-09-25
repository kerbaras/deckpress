import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { envSchema } from "./env.ts";

const env = envSchema.parse(process.env);
const application = createApp();
const { app } = application;

const server = serve(
  { fetch: app.fetch, hostname: env.HOST, port: env.PORT },
  (info) => {
    console.info(`Deckpress API listening on http://${env.HOST}:${info.port}`);
  },
);

function shutdown() {
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close((error) => {
    void application.close().finally(() => clearTimeout(timeout));
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
