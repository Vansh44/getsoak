-- =============================================================
-- Whether platform plan prices INCLUDE tax or have it added on top.
-- Design: docs/billing-architecture.md §5.
--
-- ⚠⚠ ITS OWN FILE, and that is not a style choice. `billing_01_foundation.sql`
-- has already been APPLIED, and it creates this table with
-- `CREATE TABLE IF NOT EXISTS` — so adding a column by editing that file would
-- re-run as a SILENT NO-OP and the column would never arrive. Production would
-- then hold a table matching an older copy of the file while the code wrote a
-- column Drizzle knew about, and every write would fail at runtime. That is
-- exactly the `subscriptions_02_scheduled_plan.sql` incident, which orphaned
-- Razorpay subscriptions for weeks. Anything added to an applied table needs a
-- new file. Always.
--
-- Apply as `postgres`. Idempotent.
-- =============================================================

-- ★ DEFAULT FALSE = EXCLUSIVE: the listed price is pre-tax and GST is added on
-- top, so Basic yearly ₹15,000 bills as ₹17,700. That is the ordinary B2B
-- convention in India and it matches what the code and the mandate sizing
-- already assumed, so the default changes nothing.
--
-- ⚠ But the choice has two consequences worth knowing before flipping it:
--
--  1. INCLUSIVE means turning GST on LATER CHANGES NOTHING a merchant pays —
--     the ₹15,000 simply divides into ₹12,711.86 + ₹2,288.14 GST. Under
--     EXCLUSIVE, the same switch raises every bill by 18%, which can push a
--     charge past the mandate ceiling it was authorised against and past the
--     ₹15,000 AFA-exempt limit. `mandateSizePaise` provisions ×1.18 for exactly
--     that reason, and that provision is unnecessary under inclusive pricing.
--
--  2. INCLUSIVE keeps more plans auto-collectable. Basic yearly stays at
--     ₹15,000 (on the AFA line) instead of ₹17,700 (over it), so it can still
--     be debited without the merchant authenticating each cycle.
--
-- Whichever is chosen, it must match what the pricing page advertises — a
-- merchant who signs up expecting ₹1,500 and is debited ₹1,770 will say so.
ALTER TABLE public.platform_billing_settings
  ADD COLUMN IF NOT EXISTS tax_inclusive boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.platform_billing_settings.tax_inclusive IS
  'true = plan prices already include GST (carve it out); false = GST is added on top.';

-- ───────────────────────── ROLLBACK ─────────────────────────
-- Safe only while no invoice has been FINALIZED under inclusive pricing —
-- finalized invoices are immutable and snapshot their own tax, so dropping the
-- flag does not rewrite them, but the renewal worker would silently switch
-- every future bill back to exclusive and raise it by 18%.
--
-- BEGIN;
--   ALTER TABLE public.platform_billing_settings DROP COLUMN IF EXISTS tax_inclusive;
-- COMMIT;
