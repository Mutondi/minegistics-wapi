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
// Resolves when the WS is genuinely usable for a pairing request.
// For unregistered sessions, that's when WhatsApp emits the QR event
// (server is now listening for our auth). For registered sessions,
// connection === "open". Rejects if the socket closes first or we
// hit the timeout. Reset on every fresh socket.
let socketReady: Promise<void> | null = null;

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

  sock = makeWASocket({
    auth: state,
    logger: logger.child({ module: "baileys" }) as any,
    printQRInTerminal: false,
    browser: Browsers.appropriate("Minegistics"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  let loggedQrThisLifetime = false;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((err: Error) => void) | null = null;
  socketReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Don't let an unhandled rejection crash the process if nobody awaits this
  // (e.g. boot-time auto-reconnect). Consumers that care will await it.
  socketReady.catch(() => {});
  // Hard ceiling: if neither qr nor open arrives in 20s, fail the gate so
  // requestPairing returns a clean error instead of hanging.
  const readyTimer = setTimeout(() => {
    rejectReady?.(new Error("Socket never reached a pairing-ready state"));
  }, 20_000);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // QR event = server is listening for auth. Pairing requests are now safe.
      clearTimeout(readyTimer);
      resolveReady?.();
      if (!loggedQrThisLifetime) {
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
    }

    if (connection === "open") {
      clearTimeout(readyTimer);
      resolveReady?.();
      logger.info({ user: sock?.user?.id }, "WhatsApp connection open");
    }

    if (connection === "close") {
      clearTimeout(readyTimer);
      const errAny = lastDisconnect?.error as
        | {
            output?: { statusCode?: number; payload?: unknown };
            message?: string;
          }
        | undefined;
      const status = errAny?.output?.statusCode;
      const errMessage = errAny?.message;
      const errPayload = errAny?.output?.payload;
      const isLoggedOut = status === DisconnectReason.loggedOut;
      const wasRegistered = !!sock?.authState.creds.registered;
      // Fail any pending pairing wait so the caller gets a real error.
      rejectReady?.(
        new Error(errMessage ?? `Socket closed (status=${status ?? "unknown"})`)
      );

      logger.warn(
        {
          status,
          isLoggedOut,
          wasRegistered,
          pairingInProgress,
          errMessage,
          errPayload,
        },
        wasRegistered
          ? "WhatsApp connection closed (was registered)"
          : "WhatsApp pairing session closed before registration — pairing code (if any) is now invalid"
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
    // registering, or boot-time idle when no creds existed), start one.
    // Baileys' requestPairingCode internally waits for the WebSocket to
    // be ready before sending the request, so we don't need our own wait.
    if (!sock) {
      logger.info("No live socket — starting fresh for pairing");
      await startWhatsAppClient();
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

    // Wait until WhatsApp is actually listening (qr event for unregistered,
    // open for registered). Without this, requestPairingCode can race ahead
    // of the WS handshake and throw "Connection Closed".
    if (socketReady) {
      try {
        await socketReady;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `Socket failed to reach pairing-ready state: ${message}`,
        };
      }
    }

    const code = await sock.requestPairingCode(digits);
    logger.info(
      { digits, code },
      "Pairing code generated. Socket must stay alive until user enters it on phone."
    );
    return { ok: true, code };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ message, stack }, "requestPairing threw");
    return { ok: false, error: message };
  } finally {
    pairingInProgress = false;
  }
}

export async function disconnectSession(): Promise<
  { ok: true } | { ok: false; error: string }
> {
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
    logger.info(
      "Session wiped. Call /admin/whatsapp/pair to begin a new pairing."
    );
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
