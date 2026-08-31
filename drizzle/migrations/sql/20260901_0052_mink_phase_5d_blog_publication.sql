-- Mink Phase 5D: publish or schedule one exact, saved blog proposal after an
-- authenticated admin reviews a short-lived preview. Gemini can create the
-- private proposal but never receives this execute path as a model tool.

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog'
    )
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_blog_publish_target_check,
  ADD CONSTRAINT mink_action_approvals_blog_publish_target_check CHECK (
    tool_name <> 'publish_blog'
    OR (
      resource_type = 'blog'
      AND resource_id IS NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
      AND (
        (status = 'executed' AND result_id IS NOT NULL)
        OR (status <> 'executed' AND result_id IS NULL)
      )
    )
  );

CREATE INDEX IF NOT EXISTS mink_action_approvals_blog_publish_idx
  ON public.mink_action_approvals (store_id, status, created_at DESC)
  WHERE tool_name = 'publish_blog';

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_blog_publish_target_check,
  ADD CONSTRAINT mink_action_audit_blog_publish_target_check CHECK (
    tool_name <> 'publish_blog'
    OR (
      resource_type = 'blog'
      AND resource_id IS NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND (
        (outcome = 'executed' AND result_id IS NOT NULL)
        OR (outcome <> 'executed' AND result_id IS NULL)
      )
    )
  );

CREATE INDEX IF NOT EXISTS mink_action_audit_blog_publish_idx
  ON public.mink_action_audit (store_id, result_id, created_at DESC)
  WHERE tool_name = 'publish_blog';

-- The composite uniqueness is intentionally redundant with blogs(id)'s primary
-- key: it lets the publication ledger enforce blog_id + store_id together so a
-- service-role bug cannot join one store's job to another store's blog.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.blogs'::regclass
      AND conname = 'blogs_id_store_key'
  ) THEN
    ALTER TABLE public.blogs
      ADD CONSTRAINT blogs_id_store_key UNIQUE (id, store_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.mink_blog_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  draft_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  blog_id uuid NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  scheduled_for timestamptz,
  blog_version timestamptz NOT NULL,
  published_at timestamptz,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mink_blog_publications_approval_key UNIQUE (approval_id),
  CONSTRAINT mink_blog_publications_blog_key UNIQUE (blog_id),
  CONSTRAINT mink_blog_publications_draft_store_fkey
    FOREIGN KEY (draft_id, store_id)
    REFERENCES public.mink_drafts(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT mink_blog_publications_approval_store_fkey
    FOREIGN KEY (approval_id, store_id)
    REFERENCES public.mink_action_approvals(id, store_id) ON DELETE RESTRICT,
  CONSTRAINT mink_blog_publications_blog_store_fkey
    FOREIGN KEY (blog_id, store_id)
    REFERENCES public.blogs(id, store_id) ON DELETE CASCADE,
  CONSTRAINT mink_blog_publications_mode_check
    CHECK (mode IN ('publish_now', 'schedule')),
  CONSTRAINT mink_blog_publications_status_check
    CHECK (status IN ('scheduled', 'published', 'conflicted', 'cancelled')),
  CONSTRAINT mink_blog_publications_timing_check CHECK (
    (
      mode = 'publish_now'
      AND status = 'published'
      AND scheduled_for IS NULL
      AND published_at IS NOT NULL
    )
    OR (
      mode = 'schedule'
      AND scheduled_for IS NOT NULL
      AND (
        (status = 'published' AND published_at IS NOT NULL)
        OR (status <> 'published' AND published_at IS NULL)
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS mink_blog_publications_due_idx
  ON public.mink_blog_publications (scheduled_for, created_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS mink_blog_publications_store_idx
  ON public.mink_blog_publications (store_id, status, created_at DESC);

ALTER TABLE public.mink_blog_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mink_blog_publications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mink_blog_publications FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_blog_publications TO app_service;

-- Repair documentation drift before adding Phase 5D. Existing non-empty
-- operator-authored content is preserved; a missing/unpublished guide is made
-- safe and current instead of making deployment depend on one old heading.
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
       $fallback$<p>Mink AI is StoreMink's permission-aware dashboard assistant. It can answer supported business questions from the current store and prepare private proposals for an authorised admin to review.</p>
<h2>Private proposals and approvals</h2>
<p>A saved proposal is not a live business change. Separately enabled actions show an exact, short-lived preview and require a human approval. Gemini cannot click the approval button or call the execution endpoint.</p>
<h2>Safety and limits</h2>
<p>Mink never accepts tenant identity or permission from prompt text. Campaign sends, customer contact, refunds, cancellations, payment or shipment changes, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.</p>
<h2>Draft troubleshooting</h2>
<p>Check the store invitation, drafting access, matching action switch and your Manage permission. Review a stale or expired preview again.</p>$fallback$,
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
        THEN $fallback$<p>Mink AI is StoreMink's permission-aware dashboard assistant. It can answer supported business questions and prepare private proposals.</p>
<h2>Private proposals and approvals</h2>
<p>Saving is not publishing. Every separately enabled live action needs an exact, expiring human approval.</p>
<h2>Safety and limits</h2>
<p>Never enter credentials, payment secrets or unnecessary customer information.</p>
<h2>Draft troubleshooting</h2>
<p>Check invitation, drafting, action switch and Manage permission. Review stale previews again.</p>$fallback$
      ELSE article.body
    END,
    updated_at = now()
FROM help_category
WHERE article.slug = 'use-mink-ai-in-your-dashboard';

-- Remove obsolete broad publication refusals while keeping every unsupported
-- publication domain explicit. This does not rewrite arbitrary authored prose;
-- it only upgrades sentences shipped by earlier Mink migrations.
UPDATE public.help_articles
SET body = replace(
      replace(
        replace(
          body,
          'It cannot publish, send campaigns or customer messages, refund or cancel orders, alter payments or shipments, transfer stock, change group membership, perform bulk prices or edit StoreMink source code.',
          'Outside the separately approved blog workflow, it cannot publish products, pages or storefront content, send campaigns or customer messages, refund or cancel orders, alter payments or shipments, transfer stock, change group membership, perform bulk prices or edit StoreMink source code.'
        ),
        'Publishing, campaigns, customer contact, refunds, cancellation, payment or shipment mutation, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.',
        'Product, page and storefront publishing, campaigns, customer contact, refunds, cancellation, payment or shipment mutation, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.'
      ),
      'Transfers, order-status changes, publishing, campaigns and bulk price changes remain unavailable.',
      'Transfers, product/page/storefront publishing, campaigns and bulk price changes remain unavailable.'
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard';

WITH phase5d(section) AS (
  VALUES ($phase5d$<h2>Publish or schedule one blog</h2>
<p>Mink can prepare a private Markdown blog proposal with a title, excerpt, body and optional SEO title and description. Save the proposal, choose <strong>Publish after approval</strong> or <strong>Schedule for later</strong>, then select <strong>Review exact change</strong>. You need <strong>Blogs Manage</strong> permission, drafting access and the separately enabled <strong>Blog publication and scheduling</strong> switch.</p>
<p>The preview shows the complete saved content, publication mode and exact UTC instant. It expires after 5 minutes and cannot accept a title, body, tenant ID or blog ID from the browser. Approval rechecks the signed-in store and admin, permission, switches, saved version and cryptographic payload hash inside one transaction. It creates one new blog only; retries return the original result without a second post, audit or discovery notification.</p>
<p><strong>Publish after approval</strong> makes the sanitized post live immediately. <strong>Schedule for later</strong> accepts a time from 5 minutes to 90 days ahead and first creates a private draft. An authenticated, bounded worker checks due jobs once per minute. Disabling Mink, drafting or the publication switch pauses scheduled jobs. Editing or publishing the blog through another workflow before its due time produces a conflict instead of overwriting that work. Deleting the private blog also removes its pending publication job, so the worker cannot recreate it.</p>
<p>Raw HTML is escaped and sanitized. Phase 5D supports a small Markdown subset and deliberately does not activate Markdown links, attach media, assign categories or tags, feature a post, publish a product/page/storefront version, send a campaign, contact a customer or publish every draft in bulk. Scheduled jobs have no automatic rollback; use the Blogs workspace to unpublish or edit a post after publication.</p>
$phase5d$)
)
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded answers, private drafts and explicitly approved actions including guarded blog publishing and scheduling.',
    seo_description = 'Use permission-aware Mink AI for private blog drafts, exact publication approval and guarded scheduling.',
    body = CASE
      WHEN strpos(article.body, '<h2>Draft troubleshooting</h2>') > 0
        THEN replace(
          article.body,
          '<h2>Draft troubleshooting</h2>',
          phase5d.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(article.body, E'\n', phase5d.section)
    END,
    updated_at = now()
FROM phase5d
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.body NOT LIKE '%<h2>Publish or schedule one blog</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Publish or schedule one blog</h2>%'
      AND body LIKE '%Blog publication and scheduling%'
      AND body LIKE '%from 5 minutes to 90 days ahead%'
      AND body LIKE '%does not activate Markdown links%'
      AND body LIKE '%produces a conflict instead of overwriting%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 5D blog-publication guidance was not installed';
  END IF;
END $$;
