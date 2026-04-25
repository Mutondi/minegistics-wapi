import {
  default as makeWASocket,
  Browsers,
  DisconnectReason,
  type WASocket,
} from "baileys";
import qrcode from "qrcode";
import { rm } from "node:fs/promises";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { loadAuthState } from "./auth.js";
import { attachHandlers } from "./handlers.js";

/*
  Baileys client manager.

  Pairing is no longer auto-driven from env. On boot:
    - If a persisted session exists in WA_AUTH_DIR, the client connects
      using it. No interaction needed.
    - If no session exists, the socket sits idle in the "needs pairing"
      state. The frontend calls POST /admin/whatsapp/pair with a phone
      number to drive the pairing flow.

  Public surface (exported below) is the minimum the HTTP layer needs:
    - currentSocket()       → the active WASocket or null
    - requestPairing(phone) → ask Baileys for a pairing code
    - disconnectSession()   → log out + wipe auth + restart
    - status()              → connection summary

  Reconnection is automatic on transient drops; on a "logged out"
  disconnect we stop and wait for the frontend to re-pair.
*/

let sock: WASocket | null = null;

export function currentSocket(): WASocket | null {
  return sock;
}

export async function startWhatsAppClient(): Promise<void> {
  const { state, saveCreds } = await loadAuthState();

  sock = makeWASocket({
    auth: state,
    logger: logger.child({ module: "baileys" }) as any,
    printQRInTerminal: false,
    browser: Browsers.appropriate("Minegistics"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // QR text is also rendered as ASCII to logs as a fallback. The
      // primary pairing path is the frontend POST /admin/whatsapp/pair.
      try {
        const ascii = await qrcode.toString(qr, {
          type: "terminal",
          small: true,
        });
        logger.info(
          "\n" +
            ascii +
            "\nNo phone paired yet — request a pairing code from the dashboard, or scan this QR."
        );
      } catch {
        logger.info({ qr }, "QR string (raw)");
      }
    }

    if (connection === "open") {
      logger.info({ user: sock?.user?.id }, "WhatsApp connection open");
    }

    if (connection === "close") {
      // lastDisconnect.error is a Boom-shaped object (output.statusCode)
      // but baileys exports the type opaquely — cast minimally rather than
      // pulling in @hapi/boom as a direct dep.
      const status = (
        lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      const isLoggedOut = status === DisconnectReason.loggedOut;
      logger.warn({ status, isLoggedOut }, "WhatsApp connection closed");

      if (isLoggedOut) {
        logger.error(
          "Logged out — auth state is invalid. Use /admin/whatsapp/disconnect to clear, then pair again."
        );
        sock = null;
        return;
      }
      // Transient — reconnect
      logger.info("Reconnecting in 2s…");
      setTimeout(() => {
        startWhatsAppClient().catch((err) =>
          logger.error({ err }, "Reconnect failed")
        );
      }, 2000);
    }
  });

  attachHandlers(sock);
}

export async function requestPairing(
  phone: string
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  if (!sock) {
    return { ok: false, error: "WhatsApp client is not initialised" };
  }
  if (sock.authState.creds.registered) {
    return {
      ok: false,
      error:
        "A number is already paired. Disconnect first to pair a different number.",
    };
  }
  // Baileys requires the number as digits only, no '+' or spaces.
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 8) {
    return { ok: false, error: "Phone number looks too short" };
  }
  try {
    const code = await sock.requestPairingCode(digits);
    logger.info({ digits }, "Pairing code generated for frontend request");
    return { ok: true, code };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function disconnectSession(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (sock?.authState.creds.registered) {
      try {
        await sock.logout();
      } catch (err) {
        logger.warn({ err }, "Logout call failed (continuing with wipe)");
      }
    }
    sock = null;
    await rm(config.WA_AUTH_DIR, { recursive: true, force: true });
    // Restart fresh — the new socket will sit waiting for a pairing call.
    await startWhatsAppClient();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export type WhatsAppStatus = {
  initialised: boolean;
  registered: boolean;
  connected: boolean;
  pairedNumber: string | null;
  pairedName: string | null;
};

export function status(): WhatsAppStatus {
  if (!sock) {
    return {
      initialised: false,
      registered: false,
      connected: false,
      pairedNumber: null,
      pairedName: null,
    };
  }
  const registered = !!sock.authState.creds.registered;
  const userId = sock.user?.id ?? null;
  const phone = userId ? "+" + userId.split(/[:@]/)[0] : null;
  return {
    initialised: true,
    registered,
    connected: registered && !!sock.user,
    pairedNumber: phone,
    pairedName: sock.user?.name ?? null,
  };
}
