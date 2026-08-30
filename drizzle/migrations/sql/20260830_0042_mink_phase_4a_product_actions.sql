-- Mink Phase 4A: human-approved, field-limited product description and SEO
-- actions. No model tool receives a general product-write capability.

CREATE TABLE public.mink_action_tool_access (
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  enabled_by TEXT,
  enabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, tool_name),
  CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN ('apply_product_description', 'apply_product_seo')
  ),
  CONSTRAINT mink_action_tool_access_enablement_check CHECK (
    enabled = false OR (enabled_by IS NOT NULL AND enabled_at IS NOT NULL)
  )
);

CREATE INDEX mink_action_tool_access_enabled_idx
  ON public.mink_action_tool_access (tool_name, enabled);

ALTER TABLE public.products
  ADD CONSTRAINT products_id_store_key UNIQUE (id, store_id);

CREATE TABLE public.mink_action_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL,
  draft_id UUID NOT NULL,
  product_id UUID NOT NULL,
  source_approval_id UUID,
  tool_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  draft_version INTEGER NOT NULL,
  product_version TIMESTAMPTZ NOT NULL,
  before_json JSONB NOT NULL,
  after_json JSONB NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_action_approvals_id_store_key UNIQUE (id, store_id),
  CONSTRAINT mink_action_approvals_idempotency_key
    UNIQUE (store_id, admin_id, idempotency_key),
  CONSTRAINT mink_action_approvals_draft_store_fkey
    FOREIGN KEY (draft_id, store_id)
    REFERENCES public.mink_drafts(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_action_approvals_product_store_fkey
    FOREIGN KEY (product_id, store_id)
    REFERENCES public.products(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_action_approvals_source_store_fkey
    FOREIGN KEY (source_approval_id, store_id)
    REFERENCES public.mink_action_approvals(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN ('apply_product_description', 'apply_product_seo')
  ),
  CONSTRAINT mink_action_approvals_operation_check CHECK (
    operation IN ('apply', 'rollback')
  ),
  CONSTRAINT mink_action_approvals_status_check CHECK (
    status IN ('pending', 'executed', 'conflicted', 'expired', 'cancelled')
  ),
  CONSTRAINT mink_action_approvals_draft_version_check CHECK (
    draft_version > 0
  ),
  CONSTRAINT mink_action_approvals_payload_check CHECK (
    jsonb_typeof(before_json) = 'object'
    AND jsonb_typeof(after_json) = 'object'
  ),
  CONSTRAINT mink_action_approvals_hash_check CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT mink_action_approvals_execution_check CHECK (
    (status = 'executed' AND approved_at IS NOT NULL AND executed_at IS NOT NULL)
    OR status <> 'executed'
  )
);

CREATE INDEX mink_action_approvals_owner_status_idx
  ON public.mink_action_approvals
    (store_id, admin_id, status, created_at DESC);
CREATE INDEX mink_action_approvals_product_idx
  ON public.mink_action_approvals (store_id, product_id, created_at DESC);

CREATE TABLE public.mink_action_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL,
  store_id UUID NOT NULL,
  admin_id TEXT NOT NULL,
  draft_id UUID NOT NULL,
  product_id UUID NOT NULL,
  tool_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  before_json JSONB NOT NULL,
  after_json JSONB NOT NULL,
  product_version_before TIMESTAMPTZ NOT NULL,
  product_version_after TIMESTAMPTZ,
  request_hash TEXT NOT NULL,
  tool_version INTEGER NOT NULL DEFAULT 1,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mink_action_audit_approval_key UNIQUE (approval_id),
  CONSTRAINT mink_action_audit_approval_store_fkey
    FOREIGN KEY (approval_id, store_id)
    REFERENCES public.mink_action_approvals(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN ('apply_product_description', 'apply_product_seo')
  ),
  CONSTRAINT mink_action_audit_operation_check CHECK (
    operation IN ('apply', 'rollback')
  ),
  CONSTRAINT mink_action_audit_outcome_check CHECK (
    outcome IN ('executed', 'conflicted', 'expired', 'cancelled')
  ),
  CONSTRAINT mink_action_audit_payload_check CHECK (
    jsonb_typeof(before_json) = 'object'
    AND jsonb_typeof(after_json) = 'object'
  ),
  CONSTRAINT mink_action_audit_tool_version_check CHECK (tool_version > 0)
);

CREATE INDEX mink_action_audit_store_created_idx
  ON public.mink_action_audit (store_id, created_at DESC);

ALTER TABLE public.mink_action_tool_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_action_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_action_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mink_action_tool_access,
  public.mink_action_approvals, public.mink_action_audit
  FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_action_tool_access
  TO app_service;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_action_approvals
  TO app_service;
GRANT SELECT, INSERT ON TABLE public.mink_action_audit TO app_service;

COMMENT ON TABLE public.mink_action_tool_access IS
  'Independent operator kill switches for each Mink live-action tool.';
COMMENT ON TABLE public.mink_action_approvals IS
  'Short-lived, admin-owned exact previews bound to a draft and product content version.';
COMMENT ON TABLE public.mink_action_audit IS
  'Append-only outcome log for approved Mink product actions and conflicts.';

UPDATE public.help_articles
SET excerpt = 'Use Mink AI for grounded store answers, private drafts and explicitly approved product-text changes.',
    seo_description = 'Use permission-aware Mink AI for dashboard answers, private content drafts, and guarded product description or SEO actions.',
    body = replace(
      replace(
        body,
        $old$<p><strong>Mink AI cannot publish a product or blog, send an email or message, contact a customer, or change a live business record in this phase.</strong> Saving and rollback affect only the private Mink draft. To use approved copy, open the linked dashboard destination, review it again and complete the normal StoreMink workflow yourself.</p>$old$,
        $new$<p><strong>Saving and restoring versions affect only the private Mink draft.</strong> Mink AI still cannot publish a product or blog, change a product's price, stock or status, send an email or message, or contact a customer. A separately enabled product-text action can change only the product description or SEO fields shown in its exact approval preview.</p>$new$
      ),
      '<h2>Draft troubleshooting</h2>',
      $phase4a$<h2>Approved product-text actions</h2>
<p>StoreMink support must enable product-description and product-SEO actions separately for the store. These are independent kill switches on top of the Mink beta and private-drafting gates. The signed-in admin must also have <strong>Products → Manage</strong> permission.</p>
<p>First save the private product description or product SEO proposal. Choose <strong>Review product change</strong> to see the exact current and replacement values. The preview expires after 10 minutes and is bound to that saved draft version, the linked product, its current content version and the signed-in admin. The browser cannot replace the approved text when executing it.</p>
<p>Choose <strong>Approve and apply</strong> only after checking every shown field. Product-description approval changes only the description. Product-SEO approval changes only the SEO title and SEO description. The action never changes price, inventory, variants, status, publication, images or any other product field. Published products may show approved text to shoppers after the storefront cache refreshes.</p>
<p>StoreMink executes the approved fields in one database transaction and records the before value, after value, actor, draft version, product version, action version and outcome in an append-only audit row. Retrying the same completed approval is idempotent and cannot apply it twice.</p>
<p>After a completed change, choose <strong>Review safe rollback</strong> to create another exact preview. Rollback is allowed only while the product still matches the completed action's content checkpoint. If the product or private draft changed after preview, StoreMink refuses the action without overwriting newer work; reload the latest product or draft and review again.</p>
<h2>Draft troubleshooting</h2>$phase4a$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%Approved product-text actions%'
      AND body LIKE '%Approve and apply%'
      AND body LIKE '%price, inventory, variants, status, publication, images%'
      AND body LIKE '%append-only audit row%'
      AND body LIKE '%Review safe rollback%'
  ) THEN
    RAISE EXCEPTION 'dashboard Mink AI Phase 4A guide was not updated';
  END IF;
END $$;
