import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { startWhatsAppClient } from "./whatsapp/client.js";
import { buildHttp } from "./http/routes.js";

/*
  Boot:
    1. Start the Hono HTTP server (health, readiness, admin)
    2. Initialise Baileys (loads persisted session if present, otherwise
       sits idle until POST /admin/whatsapp/pair triggers pairing)
    3. Graceful shutdown on SIGTERM/SIGINT
*/

async function main() {
  const app = buildHttp();

  // Bind 0.0.0.0 explicitly so Railway's healthcheck can reach us.
  // (Default is also 0.0.0.0 but being explicit removes ambiguity.)
  serve(
    {
      fetch: app.fetch,
      port: config.PORT,
      hostname: "0.0.0.0",
    },
    (info) => {
      logger.info({ port: info.port, host: "0.0.0.0" }, "HTTP listening");
    }
  );

  // Don't block boot on Baileys — the HTTP server must come up first
  // so Railway's healthcheck succeeds. Baileys connects in the background.
  startWhatsAppClient().catch((err) => {
    logger.error({ err }, "WhatsApp client failed to start");
  });
}

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  logger.fatal({ err }, "Fatal boot error");
  process.exit(1);
});
