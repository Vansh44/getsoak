-- Allow an offer approval to be saved at all.
--
-- ★★ 0070 WIDENED THREE TOOL ALLOWLISTS AND MISSED A FOURTH. The Mink action
-- tables carry a tool-name allowlist in three places I found by reading the
-- constraints on `mink_action_tool_access` and `mink_action_audit`, plus the
-- resource-type and target checks on `mink_action_approvals` — and
-- `mink_action_approvals` ALSO carries its own `tool_check`, which 0070 did not
-- touch. The effect was total: every offer approval, including a perfectly
-- valid one, was refused, so the whole Phase I execution path would have failed
-- at runtime with a raw constraint violation.
--
-- ★ FOUND BY THE PROBE, NOT BY REVIEW. Seven deliberately shaped approval rows
-- were inserted against a real Postgres and ALL SEVEN were refused — including
-- the two that were supposed to be accepted, which is what made it obvious
-- something other than the new budget rule was rejecting them. Reading the
-- migration would not have shown it; the constraint it missed is not mentioned
-- anywhere in the file.
--
-- ★ THE GENERAL LESSON, worth stating because the same shape will recur: when a
-- vocabulary is enumerated in more than one constraint, find them by QUERYING
-- for an existing member of that vocabulary rather than by listing the tables
-- you expect. `pg_get_constraintdef(oid) LIKE '%create_coupon%'` returns all
-- three in one line; enumerating tables by hand returned two.
ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices',
      'create_offer', 'update_offer', 'activate_offer'
    )
  );
