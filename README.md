# whatsapp-api

WhatsApp ingestion worker for Minegistics. Receives weighbridge slip photos via WhatsApp, runs them through OpenAI Vision, matches against tenant data, and inserts as draft loads in Supabase.

**Stack:** Node 20 · TypeScript · Hono · Baileys · Supabase · OpenAI Vision

## Architecture

```
WhatsApp number ──► Baileys (long-lived WebSocket)
                          │
                          ▼
                 messages.upsert event
                          │
                          ▼
              audit row in whatsapp_messages
                          │
                          ▼
        Resolve sender phone → tenant + user
                          │
                          ▼
              ┌─ image? ──► download
              │             │
              │             ▼
              │     Supabase Storage
              │             │
              │             ▼
              │       OpenAI Vision (gpt-4o)
              │             │
              │             ▼
              │     Match vehicle / source / destination
              │             │
              │             ▼
              │   Insert as draft load
              │             │
              │             ▼
              │   Reply via WhatsApp ✓
              │
              └─ text? ───► help message
```

## Setup

### 1. Apply the migration

Run [`src/migrations/01_whatsapp_tables.sql`](src/migrations/01_whatsapp_tables.sql) in the Supabase SQL editor (same project as the v2 dashboard). Creates:

- `whatsapp_users` — phone → tenant/user routing
- `whatsapp_messages` — append-only audit log

### 2. Create the Storage bucket

In Supabase Studio → Storage → New bucket:

- Name: `whatsapp-media` (or whatever `SUPABASE_STORAGE_BUCKET` is set to)
- Public: yes (so the v2 dashboard can render the slip image directly via the URL stored on `loads.imageUrl`)

### 3. Configure env

Copy `.env.example` to `.env` and fill in:

| Var | Notes |
|-----|-------|
| `SUPABASE_URL` | Your project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | From Project Settings → API. **Keeps the worker server-side only — never ship to a browser.** |
| `OPENAI_API_KEY` | OpenAI account, must have access to `gpt-4o` |
| `WA_AUTH_METHOD` | `code` (recommended on Railway — no QR scanning) or `qr` |
| `WA_PAIRING_NUMBER` | If `WA_AUTH_METHOD=code`: the phone number to pair, in international format without `+` (e.g. `27821234567`) |
| `WA_AUTH_DIR` | Where the Baileys session is stored. **On Railway, mount a persistent volume here.** Locally, `./data/auth-state` is fine. |
| `ADMIN_TOKEN` | A random string. Required to call `POST /admin/send`. |

### 4. Register users in `whatsapp_users`

Insert one row per WhatsApp number that should be allowed to send loads:

```sql
INSERT INTO public.whatsapp_users (phone, user_id, tenant_id, display_name)
VALUES ('+27821234567', '<auth-user-uuid>', '<tenant-uuid>', 'John Dispatcher');
```

Unknown senders get a polite rejection and don't write any data.

### 5. Run locally

```bash
npm install      # or yarn / pnpm
npm run dev
```

On first start the worker will print a **pairing code** in the logs. In WhatsApp on the phone you want to use:

> Settings → Linked devices → Link a device → Link with phone number instead → enter the 8-character code.

(If `WA_AUTH_METHOD=qr` it'll print a QR to logs instead — scan it the normal way.)

The auth session is then saved to `WA_AUTH_DIR` and reloaded on every restart.

### 6. Deploy to Railway

1. Push the repo to GitHub.
2. Railway → New Project → Deploy from GitHub → pick the repo.
3. Add the env vars from step 3.
4. Add a **persistent volume** mounted at `/data`. Set `WA_AUTH_DIR=/data/auth-state` so the session survives redeploys.
5. Set the **start command** to `npm start` (or let Nixpacks auto-detect).
6. After first deploy, watch the logs for the pairing code, link the phone once, and you're live.

## HTTP routes

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/health` | Liveness — always returns `200` if the server is up |
| `GET` | `/ready` | Returns `503` until Baileys is connected, `200` when ready |
| `POST` | `/admin/send` | `Authorization: Bearer $ADMIN_TOKEN`. Body: `{ "to": "+27821234567", "text": "..." }` |

## Operational notes

- **Auth state is the crown jewel.** If `WA_AUTH_DIR` gets wiped, you have to re-pair the number. On Railway, double-check the volume is mounted and `WA_AUTH_DIR` points at it.
- **Reconnection is automatic** for transient disconnects. A "logged out" disconnect (status `401`) means the auth state is invalid — clear `WA_AUTH_DIR` and restart to re-pair.
- **Don't connect the same number from two places at once.** WhatsApp will fight over the session. Use a dedicated number for the worker.
- **This is unofficial.** Baileys speaks the WhatsApp Multi-Device protocol directly — much more reliable than scraping WhatsApp Web (whatsapp-web.js), but technically still against ToS. Treat this as a bridge to the official Meta WhatsApp Cloud API; don't put a personal/critical number on it.

## What's next

- Daily summary email (currently disabled by design — was in the legacy aitwhatsapp).
- Meta WhatsApp Cloud API webhook adapter — same processor pipeline; just a new entry-point.
- Confirmation flow ("YES to confirm draft") so loads can go from `draft` → `ongoing` over WhatsApp without opening the dashboard.
