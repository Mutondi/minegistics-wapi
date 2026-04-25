import type { WAMessage, WASocket } from "baileys";
import { downloadMediaMessage } from "baileys";
import { supabase } from "../supabase/admin.js";
import { logger } from "../logger.js";
import { uploadMedia } from "./storage.js";
import { extractFromImage } from "./extract.js";
import {
  matchVehicleByHorse,
  matchSourceByName,
  matchDestinationByName,
} from "./match.js";
import { sendText, jidToPhone } from "../whatsapp/sender.js";

/*
  Main ingestion pipeline. Called for every inbound message after the
  client has logged it.

  1. Resolve sender via whatsapp_users → tenant + user
  2. If image: download → upload to Storage → OCR → match → insert draft
     load → reply with summary
  3. If text: respond with help
*/

export async function processMessage(
  sock: WASocket,
  msg: WAMessage,
  messageRowId: string
): Promise<void> {
  const fromJid = msg.key.remoteJid;
  if (!fromJid) return;

  const fromPhone = jidToPhone(fromJid);
  const ctx = await resolveSender(fromPhone);

  if (!ctx) {
    await sendText(
      sock,
      fromJid,
      "Hi! Your number isn't registered with Minegistics. Ask your workspace admin to add you."
    );
    await markStatus(messageRowId, "unknown_sender");
    return;
  }

  await annotateMessage(messageRowId, {
    user_id: ctx.userId,
    tenant_id: ctx.tenantId,
  });

  const text =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    null;
  const hasImage = !!msg.message?.imageMessage;

  if (hasImage) {
    return processImage(sock, msg, messageRowId, ctx);
  }

  const trimmed = (text ?? "").trim().toLowerCase();
  if (trimmed === "help" || trimmed === "/help") {
    await sendText(
      sock,
      fromJid,
      "Send a clear photo of a weighbridge slip and I'll log it as a draft load. You can review/confirm in the dashboard."
    );
  } else {
    await sendText(
      sock,
      fromJid,
      "Send a photo of the weighbridge slip and I'll extract it. Reply 'help' for more."
    );
  }
  await markStatus(messageRowId, "processed");
}

async function processImage(
  sock: WASocket,
  msg: WAMessage,
  messageRowId: string,
  ctx: { userId: string; tenantId: string; phone: string }
): Promise<void> {
  const fromJid = msg.key.remoteJid!;
  try {
    const buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {}
    )) as Buffer;
    const mime = msg.message?.imageMessage?.mimetype ?? "image/jpeg";

    // 1. Upload to Storage
    const upload = await uploadMedia(buffer, mime, ctx.tenantId, messageRowId);
    if ("error" in upload) {
      await sendText(sock, fromJid, "Couldn't save the image. Try again?");
      await markFailed(messageRowId, upload.error);
      return;
    }

    // 2. OCR
    const ocr = await extractFromImage(buffer, mime);
    if (!ocr.ok) {
      await sendText(
        sock,
        fromJid,
        "I couldn't read the slip clearly. Try a sharper photo?"
      );
      await markFailed(messageRowId, ocr.error);
      return;
    }
    const fields = ocr.data;

    // 3. Match against tenant data
    const vehicle = await matchVehicleByHorse(ctx.tenantId, fields.vehicle);
    const sourceId = await matchSourceByName(ctx.tenantId, fields.source);
    const destinationId = await matchDestinationByName(
      ctx.tenantId,
      fields.destination
    );

    // 4. Insert as draft
    const { data: load, error: insertErr } = await supabase()
      .from("loads")
      .insert({
        tenant_id: ctx.tenantId,
        status: "draft",
        ticketNo: fields.ticketNo,
        product: fields.product,
        netMass: fields.netMass,
        grossMass: fields.grossMass,
        seal: fields.seal,
        loadingDate: fields.loadingDate,
        notes: fields.notes,
        vehicle: vehicle?.id ?? null,
        source: sourceId,
        destination: destinationId,
        imageUrl: upload.url,
        rawExtracted: fields,
        sender: ctx.phone,
      })
      .select("id, ticketNo")
      .single();

    if (insertErr || !load) {
      logger.error({ err: insertErr }, "Failed to insert load");
      await sendText(sock, fromJid, "Couldn't save the load. Logged for review.");
      await markFailed(messageRowId, insertErr?.message ?? "insert failed");
      return;
    }

    // 5. Link the message to the load + mark processed
    await supabase()
      .from("whatsapp_messages")
      .update({
        load_id: load.id,
        status: "processed",
        processed_at: new Date().toISOString(),
      })
      .eq("id", messageRowId);

    // 6. Reply
    await sendText(sock, fromJid, formatConfirmation(fields, load.ticketNo));
  } catch (err) {
    logger.error({ err }, "Image processing failed");
    await sendText(sock, fromJid, "Hit an error processing that. Try again?");
    await markFailed(messageRowId, String(err));
  }
}

function formatConfirmation(
  fields: { vehicle: string | null; netMass: number | null; product: string | null; source: string | null },
  ticketNo: string | null
): string {
  const lines: string[] = [];
  lines.push(`✓ Logged as draft${ticketNo ? ` · ${ticketNo}` : ""}`);
  if (fields.vehicle) lines.push(`Vehicle: ${fields.vehicle}`);
  if (fields.product) lines.push(`Product: ${fields.product}`);
  if (fields.netMass != null) {
    const t = (fields.netMass / 1000).toFixed(1);
    lines.push(`Net: ${t} t`);
  }
  if (fields.source) lines.push(`Source: ${fields.source}`);
  lines.push("Review in the dashboard to confirm.");
  return lines.join("\n");
}

async function resolveSender(
  phone: string
): Promise<{ userId: string; tenantId: string; phone: string } | null> {
  const { data } = await supabase()
    .from("whatsapp_users")
    .select("user_id, tenant_id")
    .eq("phone", phone)
    .eq("active", true)
    .maybeSingle();

  if (!data) return null;
  return {
    userId: data.user_id as string,
    tenantId: data.tenant_id as string,
    phone,
  };
}

async function annotateMessage(
  rowId: string,
  fields: Record<string, unknown>
): Promise<void> {
  await supabase().from("whatsapp_messages").update(fields).eq("id", rowId);
}

async function markStatus(
  rowId: string,
  status: "processed" | "failed" | "unknown_sender"
): Promise<void> {
  await supabase()
    .from("whatsapp_messages")
    .update({
      status,
      processed_at: new Date().toISOString(),
    })
    .eq("id", rowId);
}

async function markFailed(rowId: string, error: string): Promise<void> {
  await supabase()
    .from("whatsapp_messages")
    .update({
      status: "failed",
      error,
      processed_at: new Date().toISOString(),
    })
    .eq("id", rowId);
}
