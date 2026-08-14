-- SMS — a BYO provider per store, DLT templates, a queue and a log.
-- Roadmap Step 5. CODEBASE §37.
--
-- Run as `postgres`. Idempotent: safe to re-run.
--
-- ── ★★ WHY BYO PER STORE AND NOT PLATFORM-WIDE LIKE EMAIL ──────────────────
-- TRAI's TCCCPR requires every business sending commercial SMS to an Indian
-- number to register on an operator-run DLT portal: a Principal Entity (PE-ID),
-- a 6-character alphabetic sender header, and every message template. **The
-- header IS the merchant's registered identity**, so StoreMink cannot send on
-- their behalf from a generic one — a body that does not match an approved
-- template, or a header not registered to that entity, is blocked at the
-- carrier with no bounce and no useful error.
--
-- So this mirrors `store_payment_providers` (§18), not the platform-wide Resend
-- key: the merchant brings their own account, pays the carrier directly, and
-- StoreMink never fronts a rupee or carries their spam risk.

BEGIN;

-- ── The connection ─────────────────────────────────────────────────────────
-- ★ SERVICE-ROLE ONLY, and the auth token is ADDITIONALLY encrypted at the app
-- layer (AES-256-GCM under PAYMENT_CRED_KEY — the same key the gateway creds
-- use; see lib/payments/crypto.ts). NEVER put these in stores.settings, which
-- is anon-readable (convention #9).
--
-- ⚠ ENCRYPTED, NOT HASHED, and for the same reason as the Razorpay webhook
-- secret: we have to PRESENT the token to the provider on every request, so a
-- one-way hash could not be used.
CREATE TABLE IF NOT EXISTS public.store_sms_providers (
  store_id        uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio')),
  -- Twilio's Account SID. Public-ish (it is in every dashboard URL), so it is
  -- stored in the clear and IS returned to the merchant so they can confirm
  -- which account is connected.
  account_sid     text NOT NULL,
  auth_token_enc  text NOT NULL,
  -- ★ The DLT registration. Without all three, nothing this store sends will
  -- reach an Indian handset — so they are NOT NULL rather than optional extras.
  sender_header   text NOT NULL,
  dlt_entity_id   text NOT NULL,
  enabled         boolean NOT NULL DEFAULT false,
  -- Set when the credentials last verified against the provider's API, so the
  -- console can say "connected" honestly rather than "we stored something".
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Six characters, alphabetic — the transactional/service form. A NUMERIC
  -- header is the promotional one, which a shop's order updates are not.
  CONSTRAINT store_sms_providers_header_check
    CHECK (sender_header ~ '^[A-Z]{6}$')
);

ALTER TABLE public.store_sms_providers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_sms_providers FROM anon, authenticated;

COMMENT ON TABLE public.store_sms_providers IS
  'A store''s OWN SMS account plus its DLT registration (§37). Service-role only: auth_token_enc is AES-256-GCM under PAYMENT_CRED_KEY and is never returned to any caller. sender_header is the merchant''s DLT-registered identity, which is why SMS cannot be platform-brokered.';

-- ── The template mirror ────────────────────────────────────────────────────
-- ★★ THIS IS NOT AN EMAIL TEMPLATE. §24's merchant templates are free text with
-- {{token}} substitution. A DLT body is FIXED at registration on the operator's
-- portal and only its marked {#var#} points may vary — so this table MIRRORS an
-- approval that lives elsewhere. It is deliberately not authored here.
--
-- Keyed per (store, event, audience) exactly like notification_settings'
-- templates: team copy and customer copy are configured separately, and the
-- customer's is the one that has to be DLT-approved.
CREATE TABLE IF NOT EXISTS public.store_sms_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  event_key     text NOT NULL,
  audience      text NOT NULL CHECK (audience IN ('team', 'customer')),
  -- The id the DLT portal issued. Passed to the provider on every message.
  dlt_template_id text NOT NULL,
  -- The approved body, with {#var#} at each substitution point.
  body          text NOT NULL,
  -- ★ WHICH EVENT VALUE FILLS EACH {#var#}, IN ORDER. DLT variables carry no
  -- name — the portal approves a SHAPE — so the mapping from our named event
  -- variables onto positions has to be stored, and it is exactly where a mirror
  -- drifts from a registration.
  variables     jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_sms_templates_unique UNIQUE (store_id, event_key, audience)
);

ALTER TABLE public.store_sms_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_sms_templates FROM anon, authenticated;

COMMENT ON TABLE public.store_sms_templates IS
  'MIRRORS a DLT-approved template (§37) — the body is authored and approved on the operator portal, never here. `variables` is the ordered mapping from named event values onto the template''s unnamed {#var#} positions.';

-- ── The log ────────────────────────────────────────────────────────────────
-- The email_logs shape, so /dashboard/logs/sms-logs is the same page with a
-- different table behind it.
--
-- ★ `segments` IS RECORDED, because it is what the merchant is BILLED. One
-- character outside GSM-7 — an emoji, curly quotes, ₹ — re-prices the whole
-- message from 160 characters per segment to 70, and without the number in the
-- log a merchant cannot tell why a month cost triple.
CREATE TABLE IF NOT EXISTS public.sms_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  to_phone      text NOT NULL,
  sender_header text,
  event_key     text,
  body          text,
  segments      integer NOT NULL DEFAULT 0,
  provider      text NOT NULL DEFAULT 'twilio',
  status        text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error         text,
  provider_message_id text,
  dlt_template_id text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_logs_store_created_idx
  ON public.sms_logs (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_logs_status_idx
  ON public.sms_logs (store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_logs_to_idx
  ON public.sms_logs (to_phone, created_at DESC);
-- Retention (§32) filters on created_at ALONE, which the composite above
-- cannot serve.
CREATE INDEX IF NOT EXISTS sms_logs_created_idx
  ON public.sms_logs (created_at);

ALTER TABLE public.sms_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_logs FROM anon, authenticated;

COMMENT ON TABLE public.sms_logs IS
  'Every SMS this platform sends, per store (§37). Service-role only. `segments` is what the merchant was billed — one non-GSM-7 character re-prices a whole message from 160 to 70 characters per segment.';

-- ── The queue ──────────────────────────────────────────────────────────────
-- The notification_email_queue shape. A provider round-trip must never sit on
-- a checkout's code path, so the fan-out enqueues and a worker drains.
--
-- ⚠ NO DIGEST COLUMN, unlike email. Batching a day of updates into one SMS is
-- not a thing: the segment budget makes it expensive and a digest read on a
-- phone is unreadable. An SMS event either sends now or does not send.
CREATE TABLE IF NOT EXISTS public.notification_sms_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  event_id       uuid REFERENCES public.activity_events(id) ON DELETE CASCADE,
  recipient_id   text NOT NULL,
  recipient_type text NOT NULL,
  phone          text NOT NULL,
  event_key      text NOT NULL,
  -- Snapshotted at enqueue, like the email queue's title/body: a receipt keeps
  -- the values it was written with even if the order is edited before it sends.
  values         jsonb NOT NULL DEFAULT '[]'::jsonb,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts       integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);

CREATE INDEX IF NOT EXISTS notification_sms_queue_claim_idx
  ON public.notification_sms_queue (status, next_attempt_at)
  WHERE status IN ('pending', 'sending');

-- Worker-only: RLS on, NO policies — exactly like notification_email_queue.
ALTER TABLE public.notification_sms_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_sms_queue FROM anon, authenticated;

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- ⚠ Dropping store_sms_providers destroys the merchant's stored DLT
-- registration, which they cannot re-enter from memory. Export it first.
--
-- BEGIN;
-- DROP TABLE IF EXISTS public.notification_sms_queue;
-- DROP TABLE IF EXISTS public.sms_logs;
-- DROP TABLE IF EXISTS public.store_sms_templates;
-- DROP TABLE IF EXISTS public.store_sms_providers;
-- COMMIT;
