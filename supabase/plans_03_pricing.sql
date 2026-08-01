-- Operator-editable plan pricing.
--
-- Run as `postgres`.
--
-- ── Why a table and not just lib/plans.ts ───────────────────────────────────
-- Prices were compiled in. Changing one meant a code change, a review and a
-- deploy — which is the wrong shape for a number that moves with a festival
-- sale or a competitor's launch. This table lets a platform operator set them
-- from the console and have the site reflect it immediately.
--
-- ── Base vs effective ──────────────────────────────────────────────────────
-- Two prices per plan, because the pricing page shows both:
--
--     ₹5,000  ₹2,000/month
--     ‾‾‾‾‾‾  struck through, then what you actually pay
--
--   base_*_inr       the list price, shown struck through. NULL = no discount
--                    is running, so the page shows one price and no strike.
--   monthly/yearly   what a merchant is actually charged. ALWAYS the amount
--                    billing uses — there is no path where the base price is
--                    charged.
--
-- ── Existing subscribers are not repriced ──────────────────────────────────
-- lib/payments/subscription.ts caches Razorpay plans keyed on (plan, period,
-- amount_paise), so a new price mints a NEW Razorpay plan. Anyone already
-- subscribed stays on the plan they signed up to and keeps paying what they
-- agreed to. That grandfathering is deliberate: silently raising the price of
-- a live subscription is the kind of thing that ends up in a chargeback.
--
-- ── PLATFORM-GLOBAL ────────────────────────────────────────────────────────
-- No store_id. Like platform_admins and legal_documents, this is StoreMink's
-- own configuration, not tenant data.

BEGIN;

CREATE TABLE IF NOT EXISTS public.plan_prices (
  -- Matches lib/plans.ts PLAN_IDS. Not a FK to anything — the tier list lives
  -- in code, and a row here is an override for one of them.
  plan            text PRIMARY KEY,

  -- What the merchant pays. Rupees, not paise: every display and the Razorpay
  -- amount derive from this, and paise here would invite a ×100 bug in the
  -- console where a human types the number.
  monthly_inr     integer NOT NULL,
  yearly_inr      integer NOT NULL,

  -- The struck-through list price. NULL means "no offer running".
  base_monthly_inr integer,
  base_yearly_inr  integer,

  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- The operator's email, for the audit trail. Text, because platform
  -- operators are matched by email (is_platform_admin).
  updated_by      text,

  CONSTRAINT plan_prices_plan_check
    CHECK (plan IN ('free', 'basic', 'pro')),
  CONSTRAINT plan_prices_nonneg
    CHECK (monthly_inr >= 0 AND yearly_inr >= 0),
  -- A "discount" that costs more than the list price is a data-entry mistake,
  -- and it would render as a strike-through LOWER than the price beside it.
  CONSTRAINT plan_prices_base_above
    CHECK (
      (base_monthly_inr IS NULL OR base_monthly_inr >= monthly_inr)
      AND (base_yearly_inr IS NULL OR base_yearly_inr >= yearly_inr)
    )
);

COMMENT ON TABLE public.plan_prices IS
  'Operator-set plan prices. Overrides the defaults in lib/plans.ts. base_* are the struck-through list prices; monthly/yearly are what is actually charged.';

-- Service-role only. Prices are read on the public pricing page, but that read
-- goes through the app (withService + unstable_cache), not from the browser —
-- so there is no reason to grant anon direct table access.
ALTER TABLE public.plan_prices ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS public.plan_prices;
-- COMMIT;
