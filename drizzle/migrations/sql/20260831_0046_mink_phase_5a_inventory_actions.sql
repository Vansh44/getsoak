-- Mink Phase 5A: one exact, tracked SKU at one exact active location.
-- Gemini may create only a private proposal. The authenticated approval path
-- owns the IDs, optimistic checkpoint, atomic level write and movement ledger.

ALTER TABLE public.mink_drafts
  ADD COLUMN location_id UUID,
  ADD COLUMN variant_id UUID,
  DROP CONSTRAINT mink_drafts_kind_check,
  ADD CONSTRAINT mink_drafts_kind_check CHECK (
    kind IN (
      'product_description', 'product_seo', 'blog', 'coupon_email',
      'customer_message', 'product_create', 'coupon_create', 'coupon_update',
      'customer_group_create', 'customer_group_update', 'inventory_adjustment'
    )
  ),
  ADD CONSTRAINT mink_drafts_inventory_target_check CHECK (
    kind <> 'inventory_adjustment'
    OR (destination_type = 'inventory' AND destination_id IS NOT NULL AND location_id IS NOT NULL)
  );

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory'
    )
  );

ALTER TABLE public.mink_action_approvals
  ADD COLUMN location_id UUID,
  ADD COLUMN variant_id UUID,
  DROP CONSTRAINT mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory'
    )
  ),
  DROP CONSTRAINT mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN ('product', 'coupon', 'customer_group', 'inventory')
  ),
  ADD CONSTRAINT mink_action_approvals_inventory_target_check CHECK (
    tool_name <> 'adjust_inventory'
    OR (
      resource_type = 'inventory'
      AND resource_id IS NOT NULL
      AND product_id IS NOT NULL
      AND product_id = resource_id
      AND location_id IS NOT NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
    )
  );

CREATE INDEX mink_action_approvals_inventory_idx
  ON public.mink_action_approvals
    (store_id, location_id, resource_id, variant_id, created_at DESC)
  WHERE tool_name = 'adjust_inventory';

ALTER TABLE public.mink_action_audit
  ADD COLUMN location_id UUID,
  ADD COLUMN variant_id UUID,
  DROP CONSTRAINT mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory'
    )
  ),
  DROP CONSTRAINT mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN ('product', 'coupon', 'customer_group', 'inventory')
  ),
  ADD CONSTRAINT mink_action_audit_inventory_target_check CHECK (
    tool_name <> 'adjust_inventory'
    OR (
      resource_type = 'inventory'
      AND resource_id IS NOT NULL
      AND product_id IS NOT NULL
      AND product_id = resource_id
      AND location_id IS NOT NULL
      AND operation = 'apply'
    )
  );

CREATE INDEX mink_action_audit_inventory_idx
  ON public.mink_action_audit
    (store_id, location_id, resource_id, variant_id, created_at DESC)
  WHERE tool_name = 'adjust_inventory';

COMMENT ON COLUMN public.mink_action_approvals.location_id IS
  'Trusted exact inventory location captured from the server-resolved draft target; never accepted from browser or model IDs.';
COMMENT ON COLUMN public.mink_action_approvals.variant_id IS
  'Optional exact variant checkpoint for a single-SKU inventory action.';

UPDATE public.help_articles
SET excerpt = 'Use Mink AI for grounded answers, private drafts and explicitly approved, field-limited business actions including single-SKU stock adjustments.',
    seo_description = 'Use permission-aware Mink AI for dashboard answers, private drafts, guarded business actions and exact single-location inventory adjustments.',
    body = replace(
      body,
      '<h2>Draft troubleshooting</h2>',
      $phase5a$<h2>Adjust one SKU at one location</h2>
<p>Mink can propose a stock adjustment only for one exact inventory-tracked product or variant SKU at one exact active location you can access. Ask with the visible SKU, either a signed quantity change or absolute target quantity, the location name and a reason. Mink first reads the current on-hand and reserved quantities, calculates any absolute target from that checkpoint, then creates a private proposal. It cannot use hidden IDs, adjust an untracked item, choose an inactive or inaccessible location, change multiple SKUs, transfer stock, change reservations or silently select a default location.</p>
<p>Save the proposal, select <strong>Review exact change</strong>, and verify the SKU, location, current on-hand quantity, signed change, resulting on-hand quantity, reason and audit note. The approval expires after 10 minutes. You need <strong>Inventory Manage</strong> permission, and StoreMink support must enable the single-SKU inventory action separately for your store.</p>
<p>Approval rechecks your account, store, permission, assigned location, SKU tracking state, saved proposal version and exact stock checkpoint. If stock changed in another tab, through POS, an order, import or another admin after the preview, Mink refuses the stale approval. Stock can never be reduced below zero or below its reserved units, a single change is limited to 1,000,000 units, retries cannot apply the action twice, and a successful adjustment writes the inventory level and stock-movement ledger in one database transaction.</p>
<p>Inventory corrections do not offer automatic rollback because physical stock may move after approval. To correct a completed adjustment, review the current stock and create a new explicit proposal with the inverse quantity. Phase 5A does not include bulk adjustments, transfers, order-status changes, publishing, campaigns or price updates.</p>
<h2>Draft troubleshooting</h2>$phase5a$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Adjust one SKU at one location</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%<h2>Adjust one SKU at one location</h2>%'
      AND body LIKE '%Inventory Manage%'
      AND body LIKE '%writes the inventory level and stock-movement ledger in one database transaction%'
      AND body LIKE '%do not offer automatic rollback%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 5A inventory guidance was not installed';
  END IF;
END $$;
