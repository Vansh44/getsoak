-- Mink Phase 5C: one exact, forward-only, human-approved delivery-order
-- status transition. Gemini may create the private proposal but never receives
-- the authenticated preview/execute endpoint as a model tool.

ALTER TABLE public.mink_drafts
  DROP CONSTRAINT mink_drafts_kind_check,
  DROP CONSTRAINT IF EXISTS mink_drafts_order_status_target_check,
  ADD CONSTRAINT mink_drafts_kind_check CHECK (
    kind IN (
      'product_description', 'product_seo', 'blog', 'coupon_email',
      'customer_message', 'product_create', 'coupon_create', 'coupon_update',
      'customer_group_create', 'customer_group_update', 'inventory_adjustment',
      'bulk_inventory_adjustment', 'order_status_transition'
    )
  ),
  ADD CONSTRAINT mink_drafts_order_status_target_check CHECK (
    kind <> 'order_status_transition'
    OR (
      destination_type = 'order'
      AND destination_id IS NOT NULL
      AND location_id IS NULL
      AND variant_id IS NULL
    )
  );

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status'
    )
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status'
    )
  ),
  DROP CONSTRAINT mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_order_status_target_check,
  ADD CONSTRAINT mink_action_approvals_order_status_target_check CHECK (
    tool_name <> 'transition_order_status'
    OR (
      resource_type = 'order'
      AND resource_id IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS mink_action_approvals_order_status_idx
  ON public.mink_action_approvals
    (store_id, resource_id, status, created_at DESC)
  WHERE tool_name = 'transition_order_status';

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status'
    )
  ),
  DROP CONSTRAINT mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_order_status_target_check,
  ADD CONSTRAINT mink_action_audit_order_status_target_check CHECK (
    tool_name <> 'transition_order_status'
    OR (
      resource_type = 'order'
      AND resource_id IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
    )
  );

CREATE INDEX IF NOT EXISTS mink_action_audit_order_status_idx
  ON public.mink_action_audit (store_id, resource_id, created_at DESC)
  WHERE tool_name = 'transition_order_status';

-- Repair production documentation drift before adding the new section. The
-- guide and even its category can be removed or unpublished through the
-- operator console, but a shipped customer workflow must always leave a
-- published guide. Existing non-empty operator-authored content is preserved.
INSERT INTO public.help_categories
  (slug, title, description, icon, position)
VALUES
  ('getting-started', 'Getting started',
   'Create your store, understand the dashboard, and go live.', 'Rocket', 1)
ON CONFLICT (slug) DO NOTHING;

WITH help_category AS (
  SELECT id FROM public.help_categories WHERE slug = 'getting-started'
)
INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT help_category.id,
       'use-mink-ai-in-your-dashboard',
       'Use Mink AI in your dashboard',
       'Use permission-aware Mink AI for grounded answers, private proposals and explicitly approved actions.',
       $fallback$<p>Mink AI is StoreMink's permission-aware dashboard assistant. It can answer supported business questions from the current store, prepare private proposals and, for separately enabled actions, let an authorised admin review an exact change before it runs.</p>
<h2>Open and manage Mink AI</h2>
<ol><li>Sign in to the correct store dashboard.</li><li>Select the purple Mink AI robot in the top bar or use <strong>Ask anything</strong> on Home.</li><li>Ask a business question or request one supported private proposal.</li><li>Use the conversation sidebar for the ten most recent conversations. Expand covers the full browser window; collapse returns to the resizable drawer.</li></ol>
<h2>Grounded answers and scope</h2>
<p>Mink reads only tools allowed by the signed-in admin's store, role, permissions and assigned locations. It can help with store profile, catalogue, sales, orders, inventory and published StoreMink Help. For an ambiguous multi-location inventory question, choose combined stock, compare locations or one exact accessible location instead of relying on a guessed scope.</p>
<h2>Private proposals and exact approvals</h2>
<p>A proposal is private and does not change live business data. Proposal creation uses the displayed AI-credit weight. Supported stores can separately enable exact approvals for product text and SEO, unpublished products, disabled coupons, customer-group metadata, one-SKU or maximum-20-line inventory adjustments, and one eligible delivery-order status step. Every live action requires a saved proposal, current permission, a short-lived exact preview and a human click.</p>
<h2>Safety and limits</h2>
<p>Mink never accepts store IDs, admin IDs or permissions from prompt text. It cannot publish, send campaigns or customer messages, refund or cancel orders, alter payments or shipments, transfer stock, change group membership, perform bulk prices or edit StoreMink source code. Do not enter passwords, one-time codes, payment credentials, card details, API secrets or unnecessary customer information.</p>
<h2>Draft troubleshooting</h2>
<p>If a tool is unavailable, check the admin's permission and ask StoreMink support whether the store, drafting and matching action gates are enabled. A stale, expired or changed preview must be reviewed again; retries never bypass an approval.</p>$fallback$,
       'published',
       'Use Mink AI in your StoreMink dashboard',
       'Use permission-aware Mink AI for dashboard answers, private proposals and guarded business actions.',
       101,
       now()
FROM help_category
ON CONFLICT (slug) DO NOTHING;

WITH help_category AS (
  SELECT id FROM public.help_categories WHERE slug = 'getting-started'
)
UPDATE public.help_articles AS article
SET category_id = COALESCE(article.category_id, help_category.id),
    status = 'published',
    published_at = COALESCE(article.published_at, now()),
    body = CASE
      WHEN NULLIF(btrim(article.body), '') IS NULL
        THEN $fallback$<p>Mink AI is StoreMink's permission-aware dashboard assistant. It can answer supported business questions from the current store, prepare private proposals and, for separately enabled actions, let an authorised admin review an exact change before it runs.</p>
<h2>Open and manage Mink AI</h2>
<p>Select the purple Mink AI robot in the dashboard top bar. Conversations, permissions, private proposals and exact approvals remain scoped to the signed-in store and admin.</p>
<h2>Grounded answers and scope</h2>
<p>Mink reads only permitted store, catalogue, sales, order, inventory and published Help data. It asks for an exact location scope when a multi-location stock answer would otherwise be ambiguous.</p>
<h2>Safety and limits</h2>
<p>A private proposal is not a live change. Never enter credentials, payment secrets or unnecessary customer information. Publishing, campaigns, customer contact, refunds, cancellation, payment or shipment mutation, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.</p>
<h2>Draft troubleshooting</h2>
<p>Check store invitation, drafting, matching action gate and the admin's Manage permission. Review stale or expired previews again.</p>$fallback$
      ELSE article.body
    END,
    updated_at = now()
FROM help_category
WHERE article.slug = 'use-mink-ai-in-your-dashboard';

-- Help articles are operator-editable, so a previously published heading is
-- not a safe migration anchor. Preserve the preferred placement when the
-- troubleshooting heading still exists; otherwise append the complete section
-- instead of silently updating zero content and aborting the migration.
WITH phase5c(section) AS (
  VALUES ($phase5c$<h2>Advance one delivery order</h2>
<p>Mink can prepare a private proposal for one exact visible online delivery-order reference to move one forward step: <strong>pending → processing</strong>, <strong>processing → shipped</strong> or <strong>shipped → delivered</strong>. It first reads a permission- and location-scoped order checkpoint. The checkpoint includes the current order, payment, cancellation, fulfilment, assigned-location and latest carrier-shipment state. Mink cannot use an internal order ID, skip a step, move backwards or propose a different status.</p>
<p>Save the private proposal and select <strong>Review exact change</strong>. You need <strong>Orders Manage</strong> permission, drafting access and the separately enabled <strong>Delivery order-status transitions</strong> switch. The preview shows the current and proposed status plus material payment, channel, fulfilment, location and shipment context. The exact approval expires after 5 minutes.</p>
<p>Approval rechecks the signed-in admin, store, assigned locations, permission, operator switch, proposal version, order timestamp and every material checkpoint field inside one database transaction. A payment, cancellation, location, shipment or status change makes the approval conflict. Retries are idempotent: the status, approval and append-only audit commit once, and only a newly completed execution emits the normal order-status event.</p>
<p>Phase 5C is deliberately narrow. POS sales use the register lifecycle; pickup orders use the collection workflow. Mink does not cancel or complete orders, change payment state, capture or refund money, create or modify a shipment, transfer stock, send a message or email, or perform a bulk transition. Non-COD delivery orders must already be paid. Pending or approved cancellation states and any refund activity block advancement; a previously declined cancellation is evaluated under the normal order rules. When a carrier shipment exists, Mink will not mark it shipped before pickup/transit evidence or delivered before carrier-confirmed delivery, and shipment exception/return states must be resolved in the shipment workflow.</p>
<p>Completed order-status actions do not offer automatic rollback. If a manual correction is needed, open the order and use the established Orders and shipment workflows; do not create a reverse Mink transition.</p>
$phase5c$)
)
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded answers, private drafts and explicitly approved, field-limited actions including guarded inventory and delivery-order status changes.',
    seo_description = 'Use permission-aware Mink AI for dashboard answers, private drafts and guarded inventory or delivery-order actions.',
    body = CASE
      WHEN strpos(article.body, '<h2>Draft troubleshooting</h2>') > 0
        THEN replace(
          replace(
            article.body,
            'Transfers, order-status changes, publishing, campaigns and bulk price changes remain unavailable.',
            'Stock transfers, order cancellation, refunds, payment changes, pickup/POS lifecycle changes, publishing, campaigns and bulk price changes remain unavailable.'
          ),
          '<h2>Draft troubleshooting</h2>',
          phase5c.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(
        replace(
          article.body,
          'Transfers, order-status changes, publishing, campaigns and bulk price changes remain unavailable.',
          'Stock transfers, order cancellation, refunds, payment changes, pickup/POS lifecycle changes, publishing, campaigns and bulk price changes remain unavailable.'
        ),
        E'\n',
        phase5c.section
      )
    END,
    updated_at = now()
FROM phase5c
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND body NOT LIKE '%<h2>Advance one delivery order</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Advance one delivery order</h2>%'
      AND body LIKE '%pending → processing%'
      AND body LIKE '%separately enabled <strong>Delivery order-status transitions</strong>%'
      AND body LIKE '%Pending or approved cancellation states and any refund activity block advancement%'
      AND body LIKE '%do not offer automatic rollback%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 5C order-status guidance was not installed';
  END IF;
END $$;
