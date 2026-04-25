import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { supabase } from "../supabase/admin.js";
import { logger } from "../logger.js";
import { jidToPhone } from "./sender.js";
import { processMessage } from "../ingestion/processor.js";

/*
  Wire the Baileys event listeners. Each inbound message:
    1. Drops a row into whatsapp_messages (audit log)
    2. Hands off to the ingestion processor
*/

export function attachHandlers(sock: WASocket): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      // Skip our own outbound messages and status broadcasts
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;
      if (!msg.message) continue;

      try {
        const rowId = await logInbound(msg);
        if (rowId) {
          await processMessage(sock, msg, rowId);
        }
      } catch (err) {
        logger.error({ err, msgId: msg.key.id }, "Handler crashed");
      }
    }
  });
}

async function logInbound(msg: WAMessage): Promise<string | null> {
  const fromJid = msg.key.remoteJid;
  if (!fromJid) return null;
  const fromPhone = jidToPhone(fromJid);

  const body =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    null;

  const hasImage = !!msg.message?.imageMessage;
  const mimeType = msg.message?.imageMessage?.mimetype ?? null;

  const { data, error } = await supabase()
    .from("whatsapp_messages")
    .insert({
      provider: "baileys" as unknown as string,
      provider_message_id: msg.key.id,
      direction: "inbound",
      from_phone: fromPhone,
      to_phone: "self",
      body,
      media_url: hasImage ? "pending-download" : null,
      media_content_type: mimeType,
      raw: msg as unknown as Record<string, unknown>,
      status: "received",
    })
    .select("id")
    .single();

  if (error) {
    logger.error({ err: error }, "Failed to insert whatsapp_messages row");
    return null;
  }
  return data.id as string;
}
