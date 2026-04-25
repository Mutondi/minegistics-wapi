import { supabase } from "../supabase/admin.js";

/*
  Fuzzy match free-text values from OCR against tenant-scoped tables.
  Strategy: ilike against the column, then prefer the exact-normalised
  match if present in results. Returns the matched UUID or null.

  Caller can choose to leave a load FK null when no match — the human
  reviewer fills it in via the v2 UI.
*/

function normalise(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export async function matchVehicleByHorse(
  tenantId: string,
  horse: string | null | undefined
): Promise<{ id: string; transporter: string | null } | null> {
  if (!horse?.trim()) return null;
  const norm = normalise(horse);
  if (!norm) return null;

  const { data } = await supabase()
    .from("fleet")
    .select("id, horse, transporter")
    .eq("tenant_id", tenantId)
    .ilike("horse", `%${horse.trim()}%`)
    .limit(20);

  if (!data?.length) return null;
  const exact = data.find(
    (v: { horse: string }) => normalise(v.horse) === norm
  );
  const pick = (exact ?? data[0]) as { id: string; transporter: string | null };
  return { id: pick.id, transporter: pick.transporter ?? null };
}

export async function matchSourceByName(
  tenantId: string,
  name: string | null | undefined
): Promise<string | null> {
  return matchByName(tenantId, name, "sources");
}

export async function matchDestinationByName(
  tenantId: string,
  name: string | null | undefined
): Promise<string | null> {
  return matchByName(tenantId, name, "destinations");
}

export async function matchTransporterByName(
  tenantId: string,
  name: string | null | undefined
): Promise<string | null> {
  return matchByName(tenantId, name, "transporters");
}

async function matchByName(
  tenantId: string,
  name: string | null | undefined,
  table: "sources" | "destinations" | "transporters"
): Promise<string | null> {
  if (!name?.trim()) return null;
  const norm = normalise(name);
  if (!norm) return null;

  const { data } = await supabase()
    .from(table)
    .select("id, name")
    .eq("tenant_id", tenantId)
    .ilike("name", `%${name.trim()}%`)
    .limit(10);

  if (!data?.length) return null;
  const exact = data.find(
    (r: { name: string }) => normalise(r.name) === norm
  );
  return ((exact ?? data[0]) as { id: string }).id;
}
