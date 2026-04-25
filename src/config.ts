import { z } from "zod";

/*
  Centralised, validated env config. Throws on boot if anything required
  is missing — fail fast rather than discover at runtime.

  Pairing is now driven from the frontend (v2 dashboard → Settings →
  WhatsApp), so WA_PAIRING_NUMBER is no longer an env var. The API exposes
  POST /admin/whatsapp/pair which the dashboard calls when an admin
  enters a phone number.
*/

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET: z.string().default("whatsapp-media"),

  OPENAI_API_KEY: z.string().min(20),

  // Where the Baileys auth session is persisted. On Railway, mount a
  // volume here so the session survives redeploys.
  WA_AUTH_DIR: z.string().default("./data/auth-state"),

  // Required — gates the /admin/* endpoints. The v2 dashboard stores
  // this server-side and never exposes it to the browser.
  ADMIN_TOKEN: z.string().min(16),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid env:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
