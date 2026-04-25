import type { WASocket } from "baileys";
import { logger } from "../logger.js";

/*
  Outbound message helpers. All routes through one place so we can attach
  retry/backoff or rate limiting later.
*/

export async function sendText(
  sock: WASocket,
  jid: string,
  text: string
): Promise<void> {
  try {
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error({ err, jid }, "Failed to send text");
  }
}

/*
  Convert E.164 phone (e.g. "+27821234567") to a WhatsApp JID.
  WhatsApp uses raw digits + "@s.whatsapp.net".
*/
export function phoneToJid(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return `${digits}@s.whatsapp.net`;
}

export function jidToPhone(jid: string): string {
  const m = jid.match(/^(\d+)@/);
  if (!m) return jid;
  return `+${m[1]}`;
}
