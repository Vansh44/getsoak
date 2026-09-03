-- Let an executed offer action be RECORDED, not only approved.
--
-- ★★ THE SAME MISS AS 0071, ON THE SIBLING TABLE. 0070 widened the resource
-- vocabulary on `mink_action_approvals` and left the identical enumeration on
-- `mink_action_audit` at its 0054 value, which stops at 'price_bulk'. So a
-- Phase I offer action passed every gate, wrote the offer, and then aborted on
-- its own audit insert — `resourceType: approval.resourceType` is 'offer'
-- (lib/mink/domain-actions.ts). The insert shares the transaction with the
-- write, so the offer was ROLLED BACK and the merchant got a 5xx after
-- approving. Create, update, activate and rollback alike.
--
-- ★ THE VOCABULARY LIVES IN EXACTLY TWO PLACES, and this is 0071's own lesson
-- applied rather than restated: they were found by probing for an existing
-- member (`grep price_bulk`, the file equivalent of
-- `pg_get_constraintdef(oid) LIKE '%price_bulk%'`), not by listing the tables
-- one expects. Enumerating by hand is how 0070 found one of two, and how 0070
-- found three of four tool allowlists.
--
-- ★ RESOURCE TYPE ONLY, deliberately. Every conditional target check on this
-- table is gated `tool_name <> '<its own tool>'`, so an offer row — whose tool
-- is create_offer/update_offer/activate_offer — satisfies all six vacuously.
-- Adding an audit-side offer target check to mirror
-- `mink_action_approvals_offer_target_check` would be new surface, not a fix,
-- and getting its shape wrong would reject valid rows in the direction that
-- costs an audit trail.
ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk',
      'offer'
    )
  );
