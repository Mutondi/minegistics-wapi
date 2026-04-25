import { config } from "../config.js";
import { logger } from "../logger.js";

/*
  OpenAI Vision (gpt-4o) extraction of structured load fields from a
  weighbridge slip image. Uses the REST API directly to avoid pulling in
  the openai SDK and to keep the surface area minimal.

  Output: best-effort structured JSON. Any field the model can't read
  cleanly comes back null — caller decides how to handle (insert as draft,
  ask user to retry, etc.).
*/

export type ExtractedLoad = {
  ticketNo: string | null;
  source: string | null;
  destination: string | null;
  transporter: string | null;
  vehicle: string | null;
  driver: string | null;
  product: string | null;
  seal: string | null;
  netMass: number | null;   // kg
  grossMass: number | null; // kg
  loadingDate: string | null; // ISO 8601
  notes: string | null;
};

const SYSTEM = `You extract structured load data from photos of weighbridge slips and dispatch tickets used in mining-logistics. Return STRICT JSON matching the schema. Use null when a field isn't clearly readable. Masses are in kilograms. Dates in ISO 8601 (YYYY-MM-DDTHH:mm).`;

const USER = `Extract these fields and return JSON only — no markdown, no commentary:
{
  "ticketNo": string | null,
  "source": string | null,
  "destination": string | null,
  "transporter": string | null,
  "vehicle": string | null,
  "driver": string | null,
  "product": string | null,
  "seal": string | null,
  "netMass": number | null,
  "grossMass": number | null,
  "loadingDate": string | null,
  "notes": string | null
}`;

export async function extractFromImage(
  buffer: Buffer,
  mimeType: string
): Promise<{ ok: true; data: ExtractedLoad } | { ok: false; error: string }> {
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: USER },
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, text }, "OpenAI vision call failed");
      return { ok: false, error: `OpenAI ${res.status}` };
    }

    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: "OpenAI returned no content" };

    const parsed = JSON.parse(content) as ExtractedLoad;
    return { ok: true, data: parsed };
  } catch (err) {
    logger.error({ err }, "OpenAI vision call threw");
    return { ok: false, error: String(err) };
  }
}
