import { useMultiFileAuthState, type AuthenticationState } from "baileys";
import { mkdirSync } from "node:fs";
import { config } from "../config.js";
import { logger } from "../logger.js";

/*
  Persist Baileys auth state to disk under WA_AUTH_DIR.

  On Railway: mount a volume to that path so the session survives
  container restarts. Without persistence the worker re-prompts for QR
  / pairing code on every redeploy.
*/

export async function loadAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  mkdirSync(config.WA_AUTH_DIR, { recursive: true });
  logger.info({ path: config.WA_AUTH_DIR }, "Loading auth state");
  return useMultiFileAuthState(config.WA_AUTH_DIR);
}
