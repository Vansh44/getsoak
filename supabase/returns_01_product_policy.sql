-- Returns, step 2 — per-product return policy.
-- docs/returns-exchanges-plan.md §2.3. Run as `postgres`.
--
-- ── Why a COLUMN and not a setting ─────────────────────────────────────────
-- "Allow returns only for certain products" cannot be a `lib/settings` entry:
-- that registry holds one boolean or number PER STORE and cannot address a
-- single SKU. This is per-row data, exactly like `products.tax_class_id`.
--
-- ── Why not a `return_profiles` table (the tax_classes shape) ──────────────
-- Tax classes exist because rates vary per product BY LAW and a merchant must
-- name the buckets. Return rules almost never vary by more than "returnable or
-- not, and for how long". Build the table when a merchant asks for a third
-- axis; the upgrade path is a nullable `products.return_profile_id`, which is
-- additive and breaks nothing here.
--
-- ── The backfill is today's behaviour, not the creation default ────────────
-- ★ Invariant 1: a migration may not change what a live store does. NOTHING is
-- final-sale today, so `returnable` backfills TRUE. Backfilling FALSE would
-- silently make every existing catalogue non-returnable — a policy change
-- wearing a schema change's clothes.

BEGIN;

-- Whether this product may come back at all. FALSE = final sale: perishables,
-- personalised items, clearance, opened hygiene goods.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS returnable boolean NOT NULL DEFAULT true;

-- Per-product override of the store's return window, in days.
-- NULL = use `returns.windowDays`. Deliberately nullable rather than
-- defaulting to the store value: copying the store default in at write time
-- would freeze it, so a merchant changing their store-wide window later would
-- silently not affect any product that had ever been saved.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS return_window_days integer
    CHECK (return_window_days IS NULL OR return_window_days BETWEEN 0 AND 365);

-- The storefront asks "is this final sale?" on product and order pages, and
-- the (future) returns flow filters a basket by it. Partial: the overwhelming
-- majority of rows are returnable, so indexing only the exceptions keeps it
-- tiny and still answers the question that matters.
CREATE INDEX IF NOT EXISTS products_final_sale_idx
  ON public.products (store_id)
  WHERE returnable = false;

COMMENT ON COLUMN public.products.returnable IS
  'FALSE = final sale, this product can never be returned. Backfilled TRUE because nothing was final-sale before this column existed.';
COMMENT ON COLUMN public.products.return_window_days IS
  'Per-product override of the store''s returns.windowDays. NULL means use the store setting — NOT a copy of it, so changing the store window still reaches this product.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS public.products_final_sale_idx;
-- ALTER TABLE public.products DROP COLUMN IF EXISTS return_window_days;
-- ALTER TABLE public.products DROP COLUMN IF EXISTS returnable;
-- COMMIT;
