-- Mink Phase 5F: apply one bounded, exact-SKU price set only after an
-- authenticated Products Manage admin reviews a five-minute server snapshot
-- and confirms it. Gemini may prepare the private draft, but cannot call the
-- preview or execution endpoint and cannot choose tenant or resource IDs.

ALTER TABLE public.mink_drafts
  DROP CONSTRAINT IF EXISTS mink_drafts_kind_check,
  ADD CONSTRAINT mink_drafts_kind_check CHECK (
    kind IN (
      'product_description', 'product_seo', 'blog', 'coupon_email',
      'customer_message', 'product_create', 'coupon_create', 'coupon_update',
      'customer_group_create', 'customer_group_update',
      'inventory_adjustment', 'bulk_inventory_adjustment',
      'order_status_transition', 'bulk_price_update'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_drafts_bulk_price_target_check,
  ADD CONSTRAINT mink_drafts_bulk_price_target_check CHECK (
    kind <> 'bulk_price_update'
    OR (
      destination_type = 'price_bulk'
      AND destination_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND jsonb_typeof(content_json -> 'lines_json') = 'string'
    )
  );

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices'
    )
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_bulk_price_target_check,
  ADD CONSTRAINT mink_action_approvals_bulk_price_target_check CHECK (
    tool_name <> 'bulk_update_prices'
    OR (
      resource_type = 'price_bulk'
      AND resource_id IS NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND result_id IS NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
      AND jsonb_typeof(after_json -> 'lines') = 'array'
      AND jsonb_array_length(after_json -> 'lines') BETWEEN 1 AND 20
    )
  );

CREATE INDEX IF NOT EXISTS mink_action_approvals_bulk_price_idx
  ON public.mink_action_approvals
    (store_id, admin_id, status, created_at DESC)
  WHERE tool_name = 'bulk_update_prices';

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_bulk_price_target_check,
  ADD CONSTRAINT mink_action_audit_bulk_price_target_check CHECK (
    tool_name <> 'bulk_update_prices'
    OR (
      resource_type = 'price_bulk'
      AND resource_id IS NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND result_id IS NULL
      AND operation = 'apply'
      AND jsonb_typeof(after_json -> 'lines') = 'array'
      AND jsonb_array_length(after_json -> 'lines') BETWEEN 1 AND 20
    )
  );

CREATE INDEX IF NOT EXISTS mink_action_audit_bulk_price_idx
  ON public.mink_action_audit (store_id, created_at DESC)
  WHERE tool_name = 'bulk_update_prices';

-- A variant has no independent version column. Bump its parent product's
-- content checkpoint whenever a shopper-visible variant price changes so Mink
-- and every other conflict-aware editor see the same concurrency boundary.
CREATE OR REPLACE FUNCTION public.touch_parent_product_variant_price()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.base_price IS DISTINCT FROM OLD.base_price
     OR NEW.selling_price IS DISTINCT FROM OLD.selling_price
     OR NEW.special_price IS DISTINCT FROM OLD.special_price THEN
    UPDATE public.products
    SET updated_at = now(), content_updated_at = now()
    WHERE id = NEW.product_id
      AND store_id = NEW.store_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_touch_parent_price
  ON public.product_variants;
CREATE TRIGGER product_variants_touch_parent_price
AFTER UPDATE OF base_price, selling_price, special_price
ON public.product_variants
FOR EACH ROW
EXECUTE FUNCTION public.touch_parent_product_variant_price();

REVOKE ALL ON FUNCTION public.touch_parent_product_variant_price()
  FROM PUBLIC, app_user, app_service;

-- Repair the database-backed Help Centre forward-only. Phase 5E guarantees
-- this article exists, but the guard keeps a manually repaired database safe.
UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        'Outside the separately approved coupon-email campaign workflow, customer contact, refunds, cancellations, payment or shipment changes, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.',
        'Outside the separately approved coupon-email campaign and bounded bulk-pricing workflows, customer contact, refunds, cancellations, payment or shipment changes, stock transfers and StoreMink source-code changes remain unavailable.'
      ),
      'Product, page and storefront publishing, direct customer messaging, refunds, cancellation, payment or shipment mutation, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.',
      'Product, page and storefront publishing, direct customer messaging, refunds, cancellation, payment or shipment mutation, stock transfers and StoreMink source-code changes remain unavailable.'
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard';

WITH phase5f(section) AS (
  VALUES ($phase5f$<h2>Update prices for up to 20 exact SKUs</h2>
<p>Mink can prepare one private bulk-price proposal for 1 to 20 exact sellable SKUs. Products with variants require each exact variant SKU; a parent product SKU is rejected. Save the proposal and select <strong>Review exact change</strong>. You need <strong>Products Manage</strong> permission, drafting access and the separately enabled <strong>Bulk price updates</strong> switch.</p>
<p>Every line contains the complete INR price set: MRP, selling price and either a special price or an explicit instruction to clear it. Special prices are available only for variant SKUs; a product without variants must keep that field cleared, and Mink rejects a value instead of silently ignoring it. Prices must use at most two decimal places, remain within StoreMink's supported range and satisfy MRP ≥ selling price ≥ special price &gt; 0. The server rejects duplicate, missing, ambiguous, unchanged or invalid SKU lines.</p>
<p>The preview expires after 5 minutes and shows every before-and-after price, effective-price change and an impact summary based on one unit of each selected SKU. This summary is not a sales or revenue forecast. Existing orders retain their saved prices; future storefront, checkout and POS carts use the live prices after confirmation.</p>
<p>Final confirmation rechecks the signed-in store, admin, permission, switch, saved draft version, product and variant identity, publication status, version and every current price. The entire set applies atomically: any stale or invalid line changes nothing. Retries return the original result and never apply twice. Gemini cannot call the preview or execution endpoint, choose database IDs or bypass the 20-line limit.</p>
<p>Bulk price updates do not have automatic rollback because shoppers may act on a live price. To correct a confirmed update, review a fresh proposal or edit the product manually. Test a small unpublished set first when changing unfamiliar prices.</p>
$phase5f$)
)
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded answers, private drafts and explicitly approved actions including bounded bulk price updates.',
    seo_description = 'Use permission-aware Mink AI for private exact-SKU price proposals, impact review and guarded atomic updates.',
    body = CASE
      WHEN strpos(article.body, '<h2>Draft troubleshooting</h2>') > 0
        THEN replace(
          article.body,
          '<h2>Draft troubleshooting</h2>',
          phase5f.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(article.body, E'\n', phase5f.section)
    END,
    updated_at = now()
FROM phase5f
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.body NOT LIKE '%<h2>Update prices for up to 20 exact SKUs</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Update prices for up to 20 exact SKUs</h2>%'
      AND body LIKE '%Bulk price updates%'
      AND body LIKE '%MRP ≥ selling price ≥ special price%'
      AND body LIKE '%available only for variant SKUs%'
      AND body LIKE '%applies atomically%'
      AND body LIKE '%not a sales or revenue forecast%'
      AND body LIKE '%do not have automatic rollback%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 5F bulk-pricing guidance was not installed';
  END IF;
END $$;
