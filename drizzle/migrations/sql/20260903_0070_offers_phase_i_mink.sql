-- Offers Phase I: Mink offer authority (docs/offers-plan.md §14c, §16).
--
-- Three new tools behind three new independent, DEFAULT-OFF operator gates,
-- following the Phase 4C coupon pattern exactly: a saved private proposal, an
-- exact short-lived human approval, tenant/permission/tool/version rechecks,
-- idempotent transactional execution and an append-only outcome. No model tool
-- executes; Gemini gets proposal tools only.
--
-- ★★ THREE TOOLS, NOT TWO, and the third carries the design. An offer is
-- created DISABLED and switching it on is its OWN approval with its own
-- preview. A disabled offer costs exactly nothing, so its review can take as
-- long as it needs; a live automatic offer applies itself to every qualifying
-- order from the instant it goes live, and under best-offer-wins it applies
-- whenever it is the most generous rule present. "Mink is capable of
-- everything" and "one approval does everything" are different claims.
--
-- ★★ A BUDGET CAP IS MANDATORY, enforced in the application at proposal,
-- preview, execution AND activation, and by the constraint below on the
-- approval row. A coupon needs a customer to type it; an automatic offer does
-- not, so the cap is the difference between a mistake that costs a bounded
-- amount and one that costs whatever the weekend's traffic was.

-- 1. The draft kinds a proposal may take.
ALTER TABLE public.mink_drafts
  DROP CONSTRAINT mink_drafts_kind_check,
  ADD CONSTRAINT mink_drafts_kind_check CHECK (
    kind IN (
      'product_description', 'product_seo', 'blog', 'coupon_email',
      'customer_message', 'product_create', 'coupon_create', 'coupon_update',
      'customer_group_create', 'customer_group_update', 'inventory_adjustment',
      'bulk_inventory_adjustment', 'order_status_transition',
      'bulk_price_update',
      'offer_create', 'offer_update', 'offer_activate'
    )
  );

-- 2. The gates. Each is a separate row per store, so an operator can allow
--    Mink to DRAFT offers while withholding the ability to switch one on.
ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices',
      'create_offer', 'update_offer', 'activate_offer'
    )
  );

-- 3. The audit vocabulary.
ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices',
      'create_offer', 'update_offer', 'activate_offer'
    )
  );

-- 4. The approval resource type.
ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk',
      'offer'
    )
  );

-- 5. ★★ THE BUDGET CAP, IN THE DATABASE. The application refuses a proposal,
--    a preview, an execution and an activation without one — four checks, and
--    this is the fifth, because the approval row is the durable artefact an
--    execution is replayed from. An approval saved without a budget could
--    otherwise be replayed into a live uncapped offer.
--
--    ★ COALESCED, per the trap this feature has now hit at 0062, 0064, 0065,
--    0067 and 0068: a CHECK is SATISFIED when it evaluates to NULL, so a bare
--    `(after_json ->> 'budget')::numeric > 0` accepts a payload with no budget
--    key at all — which is exactly the payload this constraint exists to stop.
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_offer_budget_check CHECK (
    tool_name NOT IN ('create_offer', 'update_offer', 'activate_offer')
    OR operation = 'rollback'
    OR (
      coalesce(after_json ->> 'budget', '') ~ '^[0-9]+(\.[0-9]{1,2})?$'
      AND (after_json ->> 'budget')::numeric > 0
    )
  );

-- 6. An offer approval names an offer and nothing else, matching the shape
--    every other target check uses.
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_offer_target_check CHECK (
    tool_name NOT IN ('create_offer', 'update_offer', 'activate_offer')
    OR (
      resource_type = 'offer'
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Help Centre
-- ---------------------------------------------------------------------------

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Extra conditions</h2>',
      $i$<h2>Letting Mink AI help with offers</h2>
<p>If your store is in the Mink AI beta and your operator has switched the offer permissions on, you can ask Mink to draft an offer for you. Three things are always true, and they are what make it safe:</p>
<ul>
<li><strong>Mink never changes anything on its own.</strong> It prepares a proposal you read and approve. Nothing is written until you approve it, and the approval is only valid for a few minutes.</li>
<li><strong>An offer Mink creates is switched off.</strong> Turning it on is a <em>separate</em> approval with its own preview, so you can take as long as you like reviewing the terms — a switched-off offer costs nothing.</li>
<li><strong>Every offer Mink proposes must have a total budget.</strong> This is not optional and cannot be removed at approval. A discount code needs a customer to type it; an automatic offer applies itself to every qualifying order the moment it goes live, so the budget is the difference between a mistake that costs a set amount and one that costs whatever your weekend traffic was.</li>
</ul>
<p>Mink can propose a percentage or a rupee amount off an order, with an optional minimum order value, an end date and a usage limit. It cannot propose bundles, free gifts, spending ladders or free delivery — those change your stock, your delivery costs or money you owe, in ways a single approval screen cannot show you honestly, so you set them up yourself.</p>
<p>A proposed discount can never be deeper than your own per-order discount limit, and that limit is checked again at the moment you approve — so tightening it takes effect on proposals already written.</p>
<p>Mink can change an offer's terms only while it is switched off, because editing a live offer changes what every basket in progress is being quoted. It can undo an offer it created only while that offer has never been switched on and has never applied to an order.</p>
<p>Your operator controls each permission separately and can withdraw any of them at any time. Drafting offers and switching them on are different permissions.</p>
<h2>Extra conditions</h2>$i$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Letting Mink AI help with offers</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Letting Mink AI help with offers</h2>%'
      AND body LIKE '%Mink never changes anything on its own%'
      AND body LIKE '%An offer Mink creates is switched off%'
      AND body LIKE '%must have a total budget%'
      AND body LIKE '%cannot propose bundles, free gifts, spending ladders or free delivery%'
  ) THEN
    RAISE EXCEPTION 'Mink offer-authority guidance was not installed';
  END IF;
END $$;
