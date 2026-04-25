import { Hono } from "hono";
import { config } from "../config.js";
import { sendText, phoneToJid } from "../whatsapp/sender.js";
import {
  currentSocket,
  disconnectSession,
  requestPairing,
  status,
} from "../whatsapp/client.js";

/*
  HTTP surface:

  Public (no auth):
    GET  /health                 — liveness (Railway healthcheck)
    GET  /ready                  — 503 until Baileys is connected

  Admin (Bearer ADMIN_TOKEN):
    GET  /admin/whatsapp/status      — connection + paired-number summary
    POST /admin/whatsapp/pair        — { phone } → { code }
    POST /admin/whatsapp/disconnect  — log out + wipe auth, restart fresh
    POST /admin/send                 — { to, text } → manual outbound

  All admin endpoints are designed to be called from the v2 dashboard's
  server actions, never the browser. The token lives in v2's server-side
  env (WHATSAPP_API_TOKEN) and the dashboard proxies the request.
*/

export function buildHttp() {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/ready", (c) => {
    const s = status();
    if (!s.connected) return c.json({ ready: false, ...s }, 503);
    return c.json({ ready: true, ...s });
  });

  // Admin auth gate
  app.use("/admin/*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${config.ADMIN_TOKEN}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/admin/whatsapp/status", (c) => c.json(status()));

  app.post("/admin/whatsapp/pair", async (c) => {
    const body = await c.req.json<{ phone?: string }>().catch(() => ({}));
    if (!body.phone) {
      return c.json({ error: "phone required" }, 400);
    }
    const result = await requestPairing(body.phone);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ code: result.code });
  });

  app.post("/admin/whatsapp/disconnect", async (c) => {
    const result = await disconnectSession();
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ ok: true });
  });

  app.post("/admin/send", async (c) => {
    const body = await c.req.json<{ to?: string; text?: string }>().catch(() => ({}));
    if (!body.to || !body.text) {
      return c.json({ error: "to + text required" }, 400);
    }
    const sock = currentSocket();
    if (!sock) return c.json({ error: "not connected" }, 503);

    await sendText(sock, phoneToJid(body.to), body.text);
    return c.json({ ok: true });
  });

  return app;
}
