import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/*
  Service-role Supabase client. Bypasses RLS — only used inside the worker,
  never exposed via HTTP. Cached as a singleton.

  We type as SupabaseClient<any, "public", any> deliberately — without a
  generated Database type, the strict generic defaults make every query
  builder return `never`, breaking insert/select calls. The `any` shape
  mirrors how the v2 dashboard's untyped server actions work today.
*/
let _client: SupabaseClient<any, "public", any> | null = null;

export function supabase(): SupabaseClient<any, "public", any> {
  if (!_client) {
    _client = createClient<any, "public", any>(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { autoRefreshToken: false, persistSession: false },
      }
    );
  }
  return _client;
}
