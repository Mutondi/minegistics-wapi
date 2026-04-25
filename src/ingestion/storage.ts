import { supabase } from "../supabase/admin.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/*
  Upload an image buffer to Supabase Storage and return the public URL.
  Bucket must exist (create once: Supabase Studio → Storage → New bucket
  named per SUPABASE_STORAGE_BUCKET, public).
*/

export async function uploadMedia(
  buffer: Buffer,
  mimeType: string,
  tenantId: string,
  messageId: string
): Promise<{ url: string; path: string } | { error: string }> {
  const ext = mimeTypeToExt(mimeType);
  const path = `${tenantId}/${messageId}.${ext}`;

  const { error } = await supabase()
    .storage.from(config.SUPABASE_STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (error) {
    logger.error({ err: error, path }, "Storage upload failed");
    return { error: error.message };
  }

  const { data } = supabase()
    .storage.from(config.SUPABASE_STORAGE_BUCKET)
    .getPublicUrl(path);

  return { url: data.publicUrl, path };
}

function mimeTypeToExt(mime: string): string {
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    default:
      return "bin";
  }
}
