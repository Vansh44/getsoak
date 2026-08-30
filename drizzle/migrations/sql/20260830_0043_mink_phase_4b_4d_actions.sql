-- Mink Phase 4B-4D: exact, human-approved creation of draft products,
-- disabled coupons, and customer-group metadata. The model still receives no
-- direct write credential; all execution is through the approval boundary.

ALTER TABLE public.mink_drafts
  DROP CONSTRAINT mink_drafts_kind_check,
  ADD CONSTRAINT mink_drafts_kind_check CHECK (
    kind IN (
      'product_description', 'product_seo', 'blog', 'coupon_email',
      'customer_message', 'product_create', 'coupon_create', 'coupon_update',
      'customer_group_create', 'customer_group_update'
    )
  );

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group'
    )
  );

ALTER TABLE public.mink_action_approvals
  ALTER COLUMN product_id DROP NOT NULL,
  ALTER COLUMN product_version DROP NOT NULL,
  ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'product',
  ADD COLUMN resource_id UUID,
  ADD COLUMN resource_version TIMESTAMPTZ,
  ADD COLUMN resource_label TEXT,
  ADD COLUMN result_id UUID,
  ADD COLUMN result_version TIMESTAMPTZ;

UPDATE public.mink_action_approvals
SET resource_type = 'product',
    resource_id = product_id,
    resource_version = product_version,
    resource_label = coalesce(resource_label, 'Product')
WHERE product_id IS NOT NULL;

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group'
    )
  ),
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN ('product', 'coupon', 'customer_group')
  );

CREATE INDEX mink_action_approvals_resource_idx
  ON public.mink_action_approvals
    (store_id, resource_type, resource_id, created_at DESC);

ALTER TABLE public.mink_action_audit
  ALTER COLUMN product_id DROP NOT NULL,
  ALTER COLUMN product_version_before DROP NOT NULL,
  ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'product',
  ADD COLUMN resource_id UUID,
  ADD COLUMN resource_version_before TIMESTAMPTZ,
  ADD COLUMN resource_version_after TIMESTAMPTZ,
  ADD COLUMN result_id UUID;

UPDATE public.mink_action_audit
SET resource_type = 'product',
    resource_id = product_id,
    resource_version_before = product_version_before,
    resource_version_after = product_version_after,
    result_id = product_id
WHERE product_id IS NOT NULL;

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group'
    )
  ),
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN ('product', 'coupon', 'customer_group')
  );

COMMENT ON TABLE public.mink_action_approvals IS
  'Short-lived, admin-owned exact previews bound to a saved draft and resource checkpoint; creation results are recorded only after approval.';
COMMENT ON TABLE public.mink_action_audit IS
  'Append-only outcomes for guarded Mink product, coupon and customer-group actions, including conflicts and safe rollback checkpoints.';

UPDATE public.help_articles
SET excerpt = 'Use Mink AI for grounded answers, private drafts and explicitly approved, field-limited business actions.',
    seo_description = 'Use permission-aware Mink AI for dashboard answers, private drafts, and guarded draft-product, disabled-coupon, and customer-group actions.',
    body = replace(
      body,
      '<h2>Draft troubleshooting</h2>',
      $phase4$<h2>Creating products, coupons and customer groups</h2>
<p>StoreMink support must enable each live-action tool separately. You must have the matching <strong>Manage</strong> permission, save the private proposal, review an exact preview, and then choose <strong>Approve</strong>. Previews expire after 10 minutes and are bound to your account, store, saved proposal version and current destination checkpoint. Retrying a completed approval cannot execute it twice.</p>
<p><strong>New products:</strong> Mink can create only an unpublished draft product with inventory tracking off. The exact preview includes its name, URL slug, description, SEO text and prices. Mink cannot choose a category, add variants, images, stock, tax or shipping settings, feature the product, or publish it. Finish those settings in the normal product editor.</p>
<p><strong>Coupons:</strong> Mink can create a new coupon or edit terms on an existing coupon only while it is disabled and hidden. It cannot activate the coupon, show it on the storefront, change its used count, add customer-group restrictions, send it to anyone or schedule a campaign. Enable and distribute the coupon later through the normal Marketing workflow.</p>
<p><strong>Customer groups:</strong> Mink can create or update only the group name, description and colour. It cannot add or remove customers, change coupon audiences, export customer data or contact anyone. Membership remains a separate manual workflow.</p>
<p>Every approval and outcome records the actor, store, proposal version, exact before and after values, resource checkpoint, action version and outcome in the Mink action audit. If the proposal or destination changes after preview, StoreMink refuses the action rather than overwriting newer work.</p>
<p>Completed actions offer a safe rollback preview. Updates roll back only while the destination still matches Mink's last checkpoint. A newly created record can be removed only while it remains unchanged and unused: draft products must have no variants or order lines, coupons must be disabled, hidden, unused and unlinked, and customer groups must have no members or coupon links. Otherwise rollback is refused.</p>
<h2>Draft troubleshooting</h2>$phase4$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body NOT LIKE '%Creating products, coupons and customer groups%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%Creating products, coupons and customer groups%'
      AND body LIKE '%unpublished draft product%'
      AND body LIKE '%disabled and hidden%'
      AND body LIKE '%name, description and colour%'
      AND body LIKE '%safe rollback preview%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 4B-4D Help Centre guidance was not installed';
  END IF;
END $$;
