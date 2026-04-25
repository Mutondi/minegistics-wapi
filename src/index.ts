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

  serve(
    { fetch: app.fetch, port: config.PORT },
    (info) => {
      logger.info({ port: info.port }, "HTTP listening");
    }
  );

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
