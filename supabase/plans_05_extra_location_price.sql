-- plan_prices: allow the `extra_location` add-on row.
-- Roadmap Step 5 / POS Phase 7. CODEBASE §22.
--
-- Run as `postgres`. Idempotent: safe to re-run.
--
-- ── Why here and not a table of its own ─────────────────────────────────────
-- An extra POS location is priced exactly like a plan is: a monthly and a
-- yearly number a platform operator sets from the console, read live when
-- billing quotes an amount, and grandfathered for existing subscribers by the
-- (plan, period, amount) key on razorpay_plans. A second table would duplicate
-- that machinery — the console panel, the cache tag, the bust-on-save, the
-- audit columns — to hold two integers.
--
-- ── It is NOT a tier, and that distinction is load-bearing ──────────────────
-- `resolvePricing` in lib/plans/pricing.ts deliberately IGNORES rows whose key
-- is not in PLAN_IDS, so this row cannot conjure a fourth card onto the public
-- pricing page. It is read by `resolveExtraLocationPrice` instead, which looks
-- only at this key. Keep that separation: widening resolvePricing to accept
-- arbitrary keys is what would put "Extra location — ₹1,000/mo" on the pricing
-- page as a plan someone can sign up to.
--
-- base_monthly_inr / base_yearly_inr stay NULL for this row. They drive the
-- struck-through list price on the pricing page, and the add-on has no card.

BEGIN;

ALTER TABLE public.plan_prices
  DROP CONSTRAINT IF EXISTS plan_prices_plan_check;

ALTER TABLE public.plan_prices
  ADD CONSTRAINT plan_prices_plan_check
  CHECK (plan IN ('free', 'basic', 'pro', 'extra_location'));

COMMENT ON TABLE public.plan_prices IS
  'Operator-set prices. Overrides the defaults in lib/plans.ts. Rows keyed on a PLAN_IDS value are tiers; the `extra_location` row prices the metered POS location add-on and is deliberately excluded from the tier map so it never renders as a pricing card. base_* are the struck-through list prices (tiers only); monthly/yearly are what is actually charged.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Delete the row FIRST or the narrowed constraint cannot be added back.
-- Removing it does NOT stop anyone being charged for locations they already
-- bought: that amount lives in the Razorpay plan their subscription is attached
-- to. It only returns the price quoted to NEW purchases to the code default.
--
-- BEGIN;
-- DELETE FROM public.plan_prices WHERE plan = 'extra_location';
-- ALTER TABLE public.plan_prices DROP CONSTRAINT IF EXISTS plan_prices_plan_check;
-- ALTER TABLE public.plan_prices
--   ADD CONSTRAINT plan_prices_plan_check CHECK (plan IN ('free', 'basic', 'pro'));
-- COMMIT;
