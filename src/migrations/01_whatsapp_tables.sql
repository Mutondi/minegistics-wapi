-- 01_whatsapp_tables.sql
--
-- Tables for the WhatsApp ingestion worker. Apply once in the same
-- Supabase project as the v2 dashboard.
--
-- whatsapp_users:
--   Maps an E.164 phone number to a user/tenant. Drives inbound message
--   routing — unknown senders get a polite rejection, known senders have
--   their messages attributed to the right workspace.
--
-- whatsapp_messages:
--   Append-only audit log of every inbound message. Provider field is
--   open-ended ("baileys", "twilio", "meta", ...) so we can layer in
--   official-API channels later without schema changes.

CREATE TABLE IF NOT EXISTS public.whatsapp_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  display_name text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_users_phone ON public.whatsapp_users (phone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_users_tenant ON public.whatsapp_users (tenant_id);

COMMENT ON TABLE public.whatsapp_users IS 'E.164 phone → user + tenant routing for the WhatsApp worker.';
COMMENT ON COLUMN public.whatsapp_users.phone IS 'E.164 with leading + and no spaces (e.g. "+27821234567").';

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  provider_message_id text,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_phone          text NOT NULL,
  to_phone            text NOT NULL,
  body                text,
  media_url           text,
  media_content_type  text,
  raw                 jsonb,
  load_id             uuid REFERENCES public.loads(id) ON DELETE SET NULL,
  tenant_id           uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  processed_at        timestamptz,
  status              text NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received', 'processed', 'failed', 'unknown_sender')),
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone ON public.whatsapp_messages (from_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_tenant ON public.whatsapp_messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_load ON public.whatsapp_messages (load_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status ON public.whatsapp_messages (status, created_at DESC);

COMMENT ON TABLE public.whatsapp_messages IS 'Append-only audit log of WhatsApp messages from any provider.';
COMMENT ON COLUMN public.whatsapp_messages.provider IS 'Channel that delivered the message: baileys, twilio, meta, etc.';
COMMENT ON COLUMN public.whatsapp_messages.status IS 'Lifecycle: received → processed | failed | unknown_sender.';
