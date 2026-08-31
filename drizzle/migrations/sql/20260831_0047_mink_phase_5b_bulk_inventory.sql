-- Mink Phase 5B: bounded, human-approved, atomic bulk inventory adjustments.
-- The model can only read exact line checkpoints and create a private proposal.
-- The authenticated approval path re-resolves all IDs and stock server-side.

ALTER TABLE public.mink_drafts
  DROP CONSTRAINT mink_drafts_kind_check,
  ADD CONSTRAINT mink_drafts_kind_check CHECK (
    kind IN (
      'product_description', 'product_seo', 'blog', 'coupon_email',
      'customer_message', 'product_create', 'coupon_create', 'coupon_update',
      'customer_group_create', 'customer_group_update', 'inventory_adjustment',
      'bulk_inventory_adjustment'
    )
  ),
  ADD CONSTRAINT mink_drafts_bulk_inventory_target_check CHECK (
    kind <> 'bulk_inventory_adjustment'
    OR (
      destination_type = 'inventory_bulk'
      AND destination_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND jsonb_typeof(content_json -> 'lines_json') = 'string'
    )
  );

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory'
    )
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory'
    )
  ),
  DROP CONSTRAINT mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk'
    )
  ),
  ADD CONSTRAINT mink_action_approvals_bulk_inventory_target_check CHECK (
    tool_name <> 'bulk_adjust_inventory'
    OR (
      resource_type = 'inventory_bulk'
      AND resource_id IS NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
      AND jsonb_typeof(after_json -> 'lines') = 'array'
      AND jsonb_array_length(after_json -> 'lines') BETWEEN 1 AND 20
    )
  );

CREATE INDEX mink_action_approvals_inventory_bulk_idx
  ON public.mink_action_approvals
    (store_id, admin_id, status, created_at DESC)
  WHERE tool_name = 'bulk_adjust_inventory';

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory'
    )
  ),
  DROP CONSTRAINT mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk'
    )
  ),
  ADD CONSTRAINT mink_action_audit_bulk_inventory_target_check CHECK (
    tool_name <> 'bulk_adjust_inventory'
    OR (
      resource_type = 'inventory_bulk'
      AND resource_id IS NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND jsonb_typeof(after_json -> 'lines') = 'array'
      AND jsonb_array_length(after_json -> 'lines') BETWEEN 1 AND 20
    )
  );

CREATE INDEX mink_action_audit_inventory_bulk_idx
  ON public.mink_action_audit (store_id, created_at DESC)
  WHERE tool_name = 'bulk_adjust_inventory';

UPDATE public.help_articles
SET excerpt = 'Use Mink AI for grounded answers, private drafts and explicitly approved, field-limited actions including guarded single and bulk inventory adjustments.',
    seo_description = 'Use permission-aware Mink AI for dashboard answers, private drafts, guarded business actions and atomic inventory adjustments.',
    body = replace(
      replace(
        body,
        'Phase 5A does not include bulk adjustments, transfers, order-status changes, publishing, campaigns or price updates.',
        'The single-SKU action does not silently become a bulk action. Use the separately enabled bulk workflow for multiple exact SKU/location lines. Transfers, order-status changes, publishing, campaigns and price updates remain unavailable.'
      ),
      '<h2>Draft troubleshooting</h2>',
      $phase5b$<h2>Adjust multiple inventory lines</h2>
<p>Mink can prepare a private bulk proposal for between 1 and 20 exact inventory-tracked SKU and active-location pairs. It reads every line in one bounded batch, returns the current on-hand, reserved and available quantities, and reports an error against each missing, duplicate, ambiguous, untracked or inaccessible line. Mink does not create or charge a proposal until every line has a valid checkpoint. It cannot use hidden IDs, select a default location, transfer stock or change reservations.</p>
<p>Each line needs a signed whole-number quantity change or an absolute target calculated from the returned checkpoint, plus a reason and an audit note when the reason is <strong>other</strong>. Save the private proposal and select <strong>Review exact change</strong> to compare every current and resulting quantity. You need <strong>Inventory Manage</strong> permission, and StoreMink support must enable <strong>Bulk inventory adjustments</strong> separately from the single-SKU action.</p>
<p>The exact approval expires after 5 minutes. Approval rechecks the current admin, store, permission, assigned active locations, tracking state, proposal version and every inventory timestamp, on-hand and reserved value. A duplicate SKU/location pair, invalid quantity, stock below zero or reserved units, or any stale line blocks the entire batch. Execution is atomic: either all lines and their stock-movement ledger entries commit once, or the database rolls the whole batch back. Retries cannot duplicate movements, events, alerts or stock changes.</p>
<p>Completed physical-stock batches do not offer automatic rollback. Review current quantities and create a new proposal for any correction. Bulk actions are capped at 20 lines to bound database work and review risk. Transfers, order-status changes, publishing, campaigns and bulk price changes remain unavailable.</p>
<h2>Draft troubleshooting</h2>$phase5b$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Adjust multiple inventory lines</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%<h2>Adjust multiple inventory lines</h2>%'
      AND body LIKE '%between 1 and 20 exact inventory-tracked SKU%'
      AND body LIKE '%Execution is atomic%'
      AND body LIKE '%database rolls the whole batch back%'
      AND body LIKE '%do not offer automatic rollback%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 5B bulk inventory guidance was not installed';
  END IF;
END $$;
