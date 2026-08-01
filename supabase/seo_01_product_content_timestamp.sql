-- ---------------------------------------------------------------------------
-- products.content_updated_at — an honest "the page changed" timestamp
--
-- RUN AS: postgres (owns products + creates triggers). Idempotent.
--
-- WHY THIS COLUMN EXISTS
--
-- app/sitemap.ts needs a <lastmod> for every product URL. It cannot use
-- products.updated_at, because _recompute_stock_aggregate (pos_01_inventory_levels.sql)
-- does `UPDATE public.products SET stock = …` on EVERY inventory movement — so a
-- product that simply sold one unit looks edited. Publishing that as lastmod
-- claims a content change per purchase, and Google's documented response to
-- lastmod values it judges unreliable is to disregard lastmod for the WHOLE
-- site — including the blog and help-article dates that ARE accurate. The
-- sitemap currently omits product lastmod entirely rather than lie; this column
-- is what lets it tell the truth instead.
--
-- WHY A TRIGGER RATHER THAN SETTING IT IN product-actions.ts
--
-- Because then it cannot be forgotten. Stock reaches products through RPCs and
-- triggers, not just the product editor, and any future writer (a bulk import,
-- a migration, an admin fixing a typo in psql) gets a correct value for free. A
-- timestamp maintained by application code is only as good as the last
-- developer who remembered it.
--
-- The trigger fires only when a column that changes what a VISITOR SEES is
-- actually different. Note `stock` is deliberately absent from that list: stock
-- alters an availability badge, not the page's content, and including it would
-- reintroduce the exact per-sale churn this exists to avoid. Same for the
-- trigger-owned identifier columns (sku/sku_no/variant_seq) and the audit
-- columns.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS content_updated_at TIMESTAMPTZ;

-- Backfill: best available approximation of "when did this page last change".
-- updated_at is wrong going forward but is the closest historical record we
-- have, and a one-time approximation is fine — what matters is that values stop
-- moving without cause from here on.
UPDATE public.products
   SET content_updated_at = COALESCE(updated_at, created_at, now())
 WHERE content_updated_at IS NULL;

ALTER TABLE public.products
  ALTER COLUMN content_updated_at SET DEFAULT now();

ALTER TABLE public.products
  ALTER COLUMN content_updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_product_content_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- IS DISTINCT FROM, not <>, so a NULL on either side compares correctly.
  IF NEW.name            IS DISTINCT FROM OLD.name
  OR NEW.slug            IS DISTINCT FROM OLD.slug
  OR NEW.description     IS DISTINCT FROM OLD.description
  OR NEW.image_url       IS DISTINCT FROM OLD.image_url
  OR NEW.images          IS DISTINCT FROM OLD.images
  OR NEW.base_price      IS DISTINCT FROM OLD.base_price
  OR NEW.selling_price   IS DISTINCT FROM OLD.selling_price
  OR NEW.status          IS DISTINCT FROM OLD.status
  OR NEW.category_id     IS DISTINCT FROM OLD.category_id
  OR NEW.seo_title       IS DISTINCT FROM OLD.seo_title
  OR NEW.seo_description IS DISTINCT FROM OLD.seo_description
  OR NEW.tax_class_id    IS DISTINCT FROM OLD.tax_class_id
  THEN
    NEW.content_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_touch_content_updated_at ON public.products;
CREATE TRIGGER products_touch_content_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.touch_product_content_updated_at();

-- The storefront reads this column through the anon role (lib/storefront/queries.ts
-- getPublishedProducts runs withAnon). It is a timestamp on already-public
-- content, so there is nothing sensitive to withhold.
GRANT SELECT (content_updated_at) ON public.products TO anon, authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- Guard: a stock-only write must NOT move content_updated_at. Run after applying
-- to prove the trigger discriminates (expects `stayed_put`).
-- ---------------------------------------------------------------------------
-- DO $$
-- DECLARE v_id uuid; v_before timestamptz; v_after timestamptz;
-- BEGIN
--   SELECT id, content_updated_at INTO v_id, v_before FROM public.products LIMIT 1;
--   IF v_id IS NULL THEN RAISE NOTICE 'no products, skipping'; RETURN; END IF;
--   UPDATE public.products SET stock = stock WHERE id = v_id;
--   SELECT content_updated_at INTO v_after FROM public.products WHERE id = v_id;
--   IF v_after IS DISTINCT FROM v_before THEN
--     RAISE EXCEPTION 'content_updated_at moved on a stock-only write';
--   END IF;
--   RAISE NOTICE 'stayed_put';
-- END $$;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- BEGIN;
-- DROP TRIGGER IF EXISTS products_touch_content_updated_at ON public.products;
-- DROP FUNCTION IF EXISTS public.touch_product_content_updated_at();
-- ALTER TABLE public.products DROP COLUMN IF EXISTS content_updated_at;
-- COMMIT;
