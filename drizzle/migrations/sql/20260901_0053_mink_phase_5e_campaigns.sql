-- Mink Phase 5E: queue or schedule one exact coupon-email campaign after an
-- authenticated admin reviews a short-lived, tenant-bound audience snapshot
-- and performs the final confirmation. Gemini can prepare the private
-- coupon_email proposal, but it is never given this options/preview/execute API.

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign'
    )
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_campaign_send_target_check,
  ADD CONSTRAINT mink_action_approvals_campaign_send_target_check CHECK (
    tool_name <> 'send_campaign'
    OR (
      resource_type = 'campaign'
      AND resource_id IS NOT NULL
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

CREATE INDEX IF NOT EXISTS mink_action_approvals_campaign_send_idx
  ON public.mink_action_approvals (store_id, status, created_at DESC)
  WHERE tool_name = 'send_campaign';

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_campaign_send_target_check,
  ADD CONSTRAINT mink_action_audit_campaign_send_target_check CHECK (
    tool_name <> 'send_campaign'
    OR (
      resource_type = 'campaign'
      AND resource_id IS NOT NULL
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

CREATE INDEX IF NOT EXISTS mink_action_audit_campaign_send_idx
  ON public.mink_action_audit (store_id, result_id, created_at DESC)
  WHERE tool_name = 'send_campaign';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.email_campaigns'::regclass
      AND conname = 'email_campaigns_id_store_key'
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT email_campaigns_id_store_key UNIQUE (id, store_id);
  END IF;
END $$;

ALTER TABLE public.email_campaign_recipients
  DROP CONSTRAINT IF EXISTS email_campaign_recipients_campaign_id_fkey,
  DROP CONSTRAINT IF EXISTS email_campaign_recipients_campaign_store_fkey,
  ADD CONSTRAINT email_campaign_recipients_campaign_store_fkey
    FOREIGN KEY (campaign_id, store_id)
    REFERENCES public.email_campaigns(id, store_id)
    ON DELETE CASCADE;

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
  ADD COLUMN IF NOT EXISTS mink_approval_id uuid,
  ADD COLUMN IF NOT EXISTS audience_mode text,
  ADD COLUMN IF NOT EXISTS audience_label text,
  ADD COLUMN IF NOT EXISTS sender_address text,
  ADD COLUMN IF NOT EXISTS brand_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  DROP CONSTRAINT IF EXISTS email_campaigns_status_check,
  ADD CONSTRAINT email_campaigns_status_check CHECK (
    status IN ('pending', 'sending', 'done', 'scheduled')
  ),
  DROP CONSTRAINT IF EXISTS email_campaigns_mink_metadata_check,
  ADD CONSTRAINT email_campaigns_mink_metadata_check CHECK (
    (
      mink_approval_id IS NULL
      AND scheduled_for IS NULL
      AND audience_mode IS NULL
      AND audience_label IS NULL
      AND sender_address IS NULL
      AND brand_snapshot IS NULL
      AND confirmed_at IS NULL
      AND status <> 'scheduled'
    )
    OR (
      mink_approval_id IS NOT NULL
      AND audience_mode IN ('all', 'group')
      AND length(btrim(audience_label)) BETWEEN 1 AND 200
      AND length(btrim(sender_address)) BETWEEN 3 AND 320
      AND jsonb_typeof(brand_snapshot) = 'object'
      AND confirmed_at IS NOT NULL
      AND (status <> 'scheduled' OR scheduled_for IS NOT NULL)
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.email_campaigns'::regclass
      AND conname = 'email_campaigns_mink_approval_key'
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT email_campaigns_mink_approval_key
      UNIQUE (mink_approval_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS email_campaigns_due_idx
  ON public.email_campaigns (scheduled_for, created_at)
  WHERE status = 'scheduled';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.email_campaigns'::regclass
      AND conname = 'email_campaigns_mink_approval_store_fkey'
  ) THEN
    ALTER TABLE public.email_campaigns
      ADD CONSTRAINT email_campaigns_mink_approval_store_fkey
      FOREIGN KEY (mink_approval_id, store_id)
      REFERENCES public.mink_action_approvals(id, store_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- A due campaign is promoted and its recipients claimed in the same statement.
-- The writable CTE is referenced explicitly because sibling CTEs share a
-- snapshot and must use READY's RETURNING rows to observe the promotion.
CREATE OR REPLACE FUNCTION public.claim_email_batch(p_limit integer)
RETURNS SETOF public.email_campaign_recipients
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ready AS (
    UPDATE public.email_campaigns
    SET status = 'pending', updated_at = now()
    WHERE status = 'scheduled'
      AND scheduled_for <= now()
    RETURNING id, store_id
  ),
  candidates AS (
    SELECT recipient.id
    FROM public.email_campaign_recipients AS recipient
    JOIN public.email_campaigns AS campaign
      ON campaign.id = recipient.campaign_id
     AND campaign.store_id = recipient.store_id
    WHERE recipient.status = 'pending'
      AND (
        campaign.status IN ('pending', 'sending')
        OR EXISTS (
          SELECT 1 FROM ready
          WHERE ready.id = campaign.id
            AND ready.store_id = campaign.store_id
        )
      )
    ORDER BY recipient.created_at
    LIMIT greatest(least(p_limit, 2000), 0)
    FOR UPDATE OF recipient SKIP LOCKED
  )
  UPDATE public.email_campaign_recipients AS recipient
  SET status = 'sending', claimed_at = now()
  WHERE recipient.id IN (SELECT id FROM candidates)
  RETURNING recipient.*;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_email_batch(integer)
  FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.claim_email_batch(integer) TO app_service;

-- Help Centre content is repaired forward-only. Preserve non-empty authored
-- prose, remove only old blanket campaign refusals shipped by Mink migrations,
-- and install Phase 5E once.
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
       $fallback$<p>Mink AI is StoreMink's permission-aware dashboard assistant. It can answer supported business questions and prepare private proposals.</p>
<h2>Private proposals and approvals</h2>
<p>Saving a proposal is not a live change. Every separately enabled action shows an exact, expiring preview and requires human confirmation.</p>
<h2>Safety and limits</h2>
<p>Never enter credentials, payment secrets or unnecessary customer information.</p>
<h2>Draft troubleshooting</h2>
<p>Check invitation, drafting, plan access, permission and the matching action switch. Review stale previews again.</p>$fallback$,
       'published',
       'Use Mink AI in your StoreMink dashboard',
       'Use permission-aware Mink AI for dashboard answers, private drafts and guarded business actions.',
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
<p>Saving a proposal is not a live change. Every separately enabled action shows an exact, expiring preview and requires human confirmation.</p>
<h2>Safety and limits</h2>
<p>Never enter credentials, payment secrets or unnecessary customer information.</p>
<h2>Draft troubleshooting</h2>
<p>Check invitation, drafting, plan access, permission and the matching action switch. Review stale previews again.</p>$fallback$
      ELSE article.body
    END,
    updated_at = now()
FROM help_category
WHERE article.slug = 'use-mink-ai-in-your-dashboard';

UPDATE public.help_articles
SET body = replace(
      replace(
        replace(
          body,
          'Campaign sends, customer contact, refunds, cancellations, payment or shipment changes, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.',
          'Outside the separately approved coupon-email campaign workflow, customer contact, refunds, cancellations, payment or shipment changes, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.'
        ),
        'Product, page and storefront publishing, campaigns, customer contact, refunds, cancellation, payment or shipment mutation, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.',
        'Product, page and storefront publishing, direct customer messaging, refunds, cancellation, payment or shipment mutation, stock transfers, bulk prices and StoreMink source-code changes remain unavailable.'
      ),
      'Phase 5D supports a small Markdown subset and deliberately does not activate Markdown links, attach media, assign categories or tags, feature a post, publish a product/page/storefront version, send a campaign, contact a customer or publish every draft in bulk.',
      'The blog workflow supports a small Markdown subset and deliberately does not activate Markdown links, attach media, assign categories or tags, feature a post, publish a product/page/storefront version, send a campaign, contact a customer or publish every draft in bulk.'
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard';

WITH phase5e(section) AS (
  VALUES ($phase5e$<h2>Send or schedule one coupon-email campaign</h2>
<p>Mink can prepare a private coupon-email proposal linked to an existing coupon. Save the proposal, choose <strong>All customers</strong> or one exact customer group, choose immediate delivery or a time from 5 minutes to 30 days ahead, then select <strong>Review exact change</strong>. You need <strong>Marketing Manage</strong> permission, Pro email-campaign access, drafting access, configured email delivery and the separately enabled <strong>Coupon email campaigns</strong> switch.</p>
<p>The server—not prompt text or browser fields—loads the signed-in store, saved subject and body, active coupon, sender identity and current audience. Phase 5E caps the source audience at 10,000 customer rows. It excludes missing or invalid email addresses, duplicate normalized addresses and globally suppressed addresses before producing a SHA-256-bound recipient snapshot. The preview shows the audience label, eligible and excluded counts, timing, sender, coupon terms, complete copy and a branded sample rendered for the literal name “Customer”; it does not expose a real recipient address or name.</p>
<p>The preview expires after 5 minutes. Final confirmation rechecks permission, plan, switches, proposal version, coupon version, sender and the exact audience hash inside one transaction. Any drift produces a conflict instead of sending to a different audience. One confirmation creates one campaign, the exact recipient rows, one approval result and one audit record atomically; retries return the original result and never duplicate a campaign. Gemini cannot call the options, preview or execution endpoints.</p>
<p>Immediate delivery is queued only after final confirmation. Scheduled delivery reuses StoreMink's authenticated email worker, which promotes due jobs before claiming recipients and never claims a future campaign. The approved sender and brand are snapshotted, so later branding edits do not silently change scheduled email. Suppression is checked again at delivery. Phase 5E does not accept arbitrary recipient IDs, multiple groups, attachments, direct customer messages or a model-triggered send. Queuing is a final send instruction and has no automatic cancellation or rollback; use a small internal test group before a broad campaign.</p>
$phase5e$)
)
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded answers, private drafts and explicitly approved actions including exact coupon-email campaigns.',
    seo_description = 'Use permission-aware Mink AI for private coupon-email drafts, exact audience review and guarded campaign scheduling.',
    body = CASE
      WHEN strpos(article.body, '<h2>Draft troubleshooting</h2>') > 0
        THEN replace(
          article.body,
          '<h2>Draft troubleshooting</h2>',
          phase5e.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(article.body, E'\n', phase5e.section)
    END,
    updated_at = now()
FROM phase5e
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.body NOT LIKE '%<h2>Send or schedule one coupon-email campaign</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Send or schedule one coupon-email campaign</h2>%'
      AND body LIKE '%Coupon email campaigns%'
      AND body LIKE '%caps the source audience at 10,000 customer rows%'
      AND body LIKE '%does not expose a real recipient address or name%'
      AND body LIKE '%never claims a future campaign%'
      AND body LIKE '%has no automatic cancellation or rollback%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 5E campaign guidance was not installed';
  END IF;
END $$;
