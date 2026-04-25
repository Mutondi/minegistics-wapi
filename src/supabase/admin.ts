import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/*
  Service-role Supabase client. Bypasses RLS — only used inside the worker,
  never exposed via HTTP. Cached as a singleton.
*/
let _client: ReturnType<typeof createClient> | null = null;

export function supabase() {
  if (!_client) {
    _client = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { autoRefreshToken: false, persistSession: false },
      }
    );
  }
  return _client;
}
