-- Clarify downgrade-safe cleanup/editing and shopper-safe shipping behavior.
-- Forward-only Help Centre update: never rewrite an applied migration.

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        '<li>Storefront custom-code sections pause below Basic and return when Basic or Pro is restored. Customer blog drafts and submissions behave the same way.</li>',
        '<li>Storefront custom-code sections pause below Basic and return when Basic or Pro is restored. A retained custom-code section can stay or be removed while the rest of the page remains editable, but its code cannot be added or changed below Basic. Customer blog drafts and submissions remain stored and return the same way.</li>'
      ),
      '<li>Existing Shiprocket connections, warehouse mappings, shipments, analytics layouts, customer groups, roles, campaigns, and POS records remain stored while their controls are locked.</li>',
      '<li>Existing customer groups and memberships remain editable below Basic, but creating another group is paused. An unused custom role may still be deleted, while creating or editing roles waits for Basic or Pro.</li><li>Existing Shiprocket connections, warehouse mappings, shipments, analytics layouts, campaigns, and POS records remain stored while paid controls are locked. If a retained store was using Shiprocket rates, shoppers receive the retained manual or free shipping option instead of a merchant plan message.</li>'
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      'On Free, existing groups, memberships, and coupon links are retained but cannot be changed until an upgrade.',
      'On Free, existing groups, memberships, and coupon links are retained and remain editable; creating another group is paused until an upgrade.'
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-customer-groups'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      'On Free, saved code stays in the page record but does not run on the storefront; upgrading restores it.',
      'On Free, saved code stays in the page record but does not run on the storefront. The section can stay or be removed while other page sections remain editable, but its code cannot be added or changed until Basic or Pro returns.'
    ),
    updated_at = now()
WHERE slug = 'add-safe-custom-code-to-a-page'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      'A move to Free pauses new provider operations but retains the encrypted connection, warehouse mappings, and shipment history for a later upgrade.',
      'A move to Free pauses new provider operations but retains the encrypted connection, warehouse mappings, and shipment history for a later upgrade. Storefront checkout falls back to the retained manual or free shipping settings and never shows shoppers a merchant upgrade message.'
    ),
    updated_at = now()
WHERE slug = 'connect-shiprocket-and-sync-warehouses'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Create a role</h2>',
      '<p><strong>Plan availability:</strong> Creating and editing custom roles requires Basic or Pro. After a move to Free, existing roles and assignments remain stored and an unused custom role can still be deleted after its staff are reassigned.</p><h2>Create a role</h2>'
    ),
    updated_at = now()
WHERE slug = 'create-roles-permissions-and-location-access'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'manage-your-storemink-plan-and-subscription'
      AND body LIKE '%Existing customer groups and memberships remain editable below Basic%'
      AND body LIKE '%shoppers receive the retained manual or free shipping option%'
  ) THEN
    RAISE EXCEPTION 'plan downgrade follow-up guidance was not updated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'add-safe-custom-code-to-a-page'
      AND body LIKE '%other page sections remain editable%'
  ) THEN
    RAISE EXCEPTION 'custom-code downgrade guidance was not updated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'create-roles-permissions-and-location-access'
      AND body LIKE '%unused custom role can still be deleted%'
  ) THEN
    RAISE EXCEPTION 'custom-role downgrade guidance was not updated';
  END IF;
END $$;
