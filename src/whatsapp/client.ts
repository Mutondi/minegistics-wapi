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
import { proxyAgent } from "./proxy.js";

/*
  Baileys client manager.

  Lifecycle:
    - Boot: if persisted creds exist → connect and stay connected.
                 if not → start a socket but DON'T reconnect on close. The
                 socket sits waiting for /admin/whatsapp/pair to drive
                 the pairing flow.
    - Pair:  /admin/whatsapp/pair starts a fresh socket if needed,
                 waits for the QR event, calls requestPairingCode, returns
                 the code to the caller.
    - Drop:  if a registered session drops mid-life → auto-reconnect.
                 if an unregistered (pairing) session drops → stop. Don't
                 churn the WebSocket; let the user retry.
*/

let sock: WASocket | null = null;
let pairingInProgress = false;

export function currentSocket(): WASocket | null {
  return sock;
}

export async function startWhatsAppClient(): Promise<void> {
  // Avoid creating a second client if one is already alive
  if (sock) {
    logger.debug("startWhatsAppClient called but socket already alive");
    return;
  }

  const { state, saveCreds } = await loadAuthState();
  const agent = proxyAgent();

  sock = makeWASocket({
    auth: state,
    logger: logger.child({ module: "baileys" }) as any,
    printQRInTerminal: false,
    browser: Browsers.appropriate("Minegistics"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // When set, all WS + media-fetch traffic routes through the proxy.
    // Recommended in production to stabilise the outbound IP.
    ...(agent ? { agent, fetchAgent: agent } : {}),
  });

  sock.ev.on("creds.update", saveCreds);

  let loggedQrThisLifetime = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !loggedQrThisLifetime) {
      loggedQrThisLifetime = true;
      try {
        const ascii = await qrcode.toString(qr, {
          type: "terminal",
          small: true,
        });
        logger.info(
          "\n" +
            ascii +
            "\nNo phone paired yet — request a pairing code via the dashboard, or scan this QR."
        );
      } catch {
        logger.info({ qr }, "QR string (raw)");
      }
    }

    if (connection === "open") {
      logger.info({ user: sock?.user?.id }, "WhatsApp connection open");
    }

    if (connection === "close") {
      const status = (
        lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      const isLoggedOut = status === DisconnectReason.loggedOut;
      const wasRegistered = !!sock?.authState.creds.registered;

      logger.warn(
        { status, isLoggedOut, wasRegistered, pairingInProgress },
        "WhatsApp connection closed"
      );

      sock = null;

      if (isLoggedOut) {
        logger.error(
          "Logged out — auth state is invalid. Use /admin/whatsapp/disconnect to clear, then pair again."
        );
        return;
      }

      if (!wasRegistered) {
        // Initial pairing failed (timeout, 405, etc.). Don't loop —
        // wait for the next /admin/whatsapp/pair call.
        logger.info(
          "Pairing session ended without registration. Waiting for /admin/whatsapp/pair."
        );
        return;
      }

      // Registered + transient drop → reconnect
      logger.info("Registered session dropped. Reconnecting in 2s…");
      setTimeout(() => {
        startWhatsAppClient().catch((err) =>
          logger.error({ err }, "Reconnect failed")
        );
      }, 2000);
    }
  });

  attachHandlers(sock);
}

/*
  Wait until the live socket emits a QR (= ready to issue a pairing code).
  Resolves with `true` if QR arrived in time, `false` on timeout.
*/
async function waitForQrEvent(timeoutMs = 15_000): Promise<boolean> {
  if (!sock) return false;
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    const handler = (update: { qr?: string }) => {
      if (update.qr) {
        clearTimeout(t);
        sock?.ev.off("connection.update", handler);
        resolve(true);
      }
    };
    sock!.ev.on("connection.update", handler);
  });
}

export async function requestPairing(
  phone: string
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 8) {
    return { ok: false, error: "Phone number looks too short" };
  }

  if (pairingInProgress) {
    return {
      ok: false,
      error: "A pairing attempt is in progress. Wait a few seconds and retry.",
    };
  }
  pairingInProgress = true;

  try {
    // If we don't have a live socket (e.g. last attempt closed without
    // registering), start a fresh one.
    if (!sock) {
      logger.info("No live socket — starting fresh for pairing");
      await startWhatsAppClient();
      // Wait for the QR event before calling requestPairingCode.
      const ready = await waitForQrEvent();
      if (!ready) {
        return {
          ok: false,
          error: "Timed out waiting for WhatsApp socket to be ready. Try again.",
        };
      }
    }

    if (!sock) {
      return { ok: false, error: "WhatsApp client failed to initialise" };
    }

    if (sock.authState.creds.registered) {
      return {
        ok: false,
        error:
          "A number is already paired. Disconnect first to pair a different number.",
      };
    }

    const code = await sock.requestPairingCode(digits);
    logger.info({ digits }, "Pairing code generated");
    return { ok: true, code };
  } catch (err) {
    logger.error({ err }, "requestPairing threw");
    return { ok: false, error: String(err) };
  } finally {
    pairingInProgress = false;
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
    // Don't pre-start a new socket — let the next /admin/whatsapp/pair
    // request boot it. Avoids the loop we just fixed.
    logger.info("Session wiped. Call /admin/whatsapp/pair to begin a new pairing.");
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
