-- Per-store Razorpay webhook secret (CODEBASE §18).
--
-- Until now a merchant's own gateway had NO webhook: a payment was only learned
-- when the shopper's success page ran reconcile-on-read, or when the hourly
-- reaper swept. If the shopper closed the tab on the Razorpay screen, the money
-- was captured at Razorpay and the order sat `pending` for up to an hour.
--
-- ★ ENCRYPTED, NOT HASHED — and that is forced by the protocol. The logistics
-- webhook stores a SHA-256 hash of its token, because Shiprocket presents the
-- token itself and we only need to compare. Razorpay instead HMACs the request
-- body with the shared secret, so verification needs the secret in plaintext at
-- request time. It therefore gets the same treatment as `key_secret_enc`:
-- AES-256-GCM under `PAYMENT_CRED_KEY` (lib/payments/crypto.ts).
--
-- ⚠ `store_payment_providers` is SERVICE-ROLE ONLY (no anon/authenticated
-- grants), which is what makes storing a reversible secret acceptable here. Do
-- not move it to `stores.settings`, which is anon-readable (§9).
--
-- ⚠ ITS OWN FILE. `payment_providers.sql` has already been applied in
-- production, and editing an applied migration is a silent no-op (§15b).
-- Re-running this file is safe.
--
-- Apply as `postgres` via the Cloud SQL proxy.

alter table public.store_payment_providers
  add column if not exists webhook_secret_enc text;

comment on column public.store_payment_providers.webhook_secret_enc is
  'AES-256-GCM (PAYMENT_CRED_KEY) Razorpay webhook signing secret. Reversible '
  'because Razorpay HMACs the request body — a hash cannot verify that. Shown '
  'to the merchant once, on generation.';

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'store_payment_providers'
      and column_name = 'webhook_secret_enc'
  ) then
    raise exception 'payments_02: webhook_secret_enc missing';
  end if;

  -- The whole reason this is safe to store reversibly.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'store_payment_providers'
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception
      'payments_02: store_payment_providers is reachable by anon/authenticated — '
      'a reversible secret must not live there';
  end if;

  raise notice 'payments_02: webhook_secret_enc present, table still service-role only';
end $$;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- alter table public.store_payment_providers drop column if exists webhook_secret_enc;
