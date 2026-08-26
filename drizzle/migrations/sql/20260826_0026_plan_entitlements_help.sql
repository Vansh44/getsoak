-- Plan feature matrix + soft-downgrade contract.
-- Forward-only Help Centre update: never rewrite an applied migration.

UPDATE public.help_articles
SET excerpt = 'Compare every Free, Basic, and Pro entitlement and understand exactly what happens to store data after a downgrade or failed payment.',
    body = $plan$<p>StoreMink creates every new store on <strong>Free</strong>. Open <strong>Plan &amp; billing</strong> to see the effective plan, live price, billing period, subscription state, AI usage, invoices, and upgrade options.</p>
<h2>Complete feature matrix</h2>
<table><thead><tr><th>Feature</th><th>Free</th><th>Basic</th><th>Pro</th></tr></thead><tbody>
<tr><td>Products</td><td>5</td><td>50</td><td>Unlimited</td></tr>
<tr><td>Staff accounts, including the owner</td><td>1</td><td>3</td><td>Unlimited</td></tr>
<tr><td>Active coupons</td><td>3</td><td>Unlimited</td><td>Unlimited</td></tr>
<tr><td>Included AI generations each month</td><td>3</td><td>10</td><td>50</td></tr>
<tr><td>Hosted storefront, StoreMink subdomain, themes, visual builder, customer accounts, reviews, enquiries, COD, GST invoices, inventory, orders and returns</td><td>Included</td><td>Included</td><td>Included</td></tr>
<tr><td>Buy additional non-expiring AI credits</td><td>Included</td><td>Included</td><td>Included</td></tr>
<tr><td>Online payments through your own gateway</td><td>—</td><td>Included</td><td>Included</td></tr>
<tr><td>Customer blog submissions</td><td>—</td><td>Included</td><td>Included</td></tr>
<tr><td>Customer groups, custom roles, custom-code page sections, Shiprocket, dashboard customization, detailed reports, CSV and Search Console analytics</td><td>—</td><td>Included</td><td>Included</td></tr>
<tr><td>Custom domain</td><td>—</td><td>—</td><td>Included</td></tr>
<tr><td>Email campaigns, GA4, Meta Pixel, storefront conversion, gross margin and Point of Sale</td><td>—</td><td>—</td><td>Included</td></tr>
<tr><td>Multi-location stock, transfers and store pickup</td><td>—</td><td>—</td><td>Included</td></tr>
<tr><td>Included POS locations and authorised tills</td><td>—</td><td>—</td><td>2 locations, 5 tills per location</td></tr>
<tr><td>Powered by StoreMink badge</td><td>Shown</td><td>Removed</td><td>Removed</td></tr>
</tbody></table>
<h2>What happens after a downgrade or failed payment</h2>
<p><strong>StoreMink does not delete store data because a plan becomes lower.</strong> Products, variants, media references, staff profiles, roles, groups, memberships, coupon links, blog drafts and submissions, page code, analytics layouts, campaign history, Shiprocket credentials and mappings, locations, inventory, orders, fulfilment, and POS history stay stored.</p>
<ul><li>Every existing product remains visible and editable, even when the current count is above the new limit. Creating another product is blocked until the store upgrades or falls below the limit.</li><li>Existing staff and active coupons remain in place. New invitations or newly activated coupons are checked against the current limit.</li><li>Paid features become unavailable at runtime, but their saved settings and records are not reset. Upgrading to an eligible plan restores access to the same data.</li><li>Storefront custom-code sections pause below Basic and return when Basic or Pro is restored. Customer blog drafts and submissions behave the same way.</li><li>A saved custom domain is retained but resolves only on Pro. The StoreMink subdomain remains available.</li><li>Existing Shiprocket connections, warehouse mappings, shipments, analytics layouts, customer groups, roles, campaigns, and POS records remain stored while their controls are locked.</li></ul>
<p>This soft-limit behavior applies when a merchant chooses a downgrade and when billing moves a store to Free after a declined or unresolved payment.</p>
<h2>Change, cancel, or resume a plan</h2>
<ul><li>A higher-cost change applies after the required payment.</li><li>A cheaper or equal-cost change is normally scheduled for the end of the paid cycle.</li><li>Before a scheduled cancellation takes effect, use <strong>Keep my plan</strong> to resume.</li><li>Do not pay twice when Razorpay captured a payment but confirmation is pending. Refresh first so StoreMink can reconcile it.</li></ul>
<p>AI-credit packs are separate one-time purchases on every plan. Purchased and granted credits do not expire and remain with the store through plan changes.</p>$plan$,
    seo_description = 'Compare StoreMink Free Basic and Pro features, exact limits, billing changes, and the no-data-loss behavior after downgrades or failed payments.',
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Published plan allowances</h2>
<ul><li><strong>Free:</strong> up to 25 products.</li><li><strong>Basic:</strong> up to 500 products.</li><li><strong>Pro:</strong> unlimited products.</li></ul>
<p>These are the product allowances published for each plan. StoreMink does not delete products after a downgrade. <strong>Current limitation:</strong> the product-creation action does not yet enforce the published cap automatically, so do not treat a successful save above the allowance as a plan upgrade or a larger entitlement.</p>$old$,
      $new$<h2>Plan allowances</h2>
<ul><li><strong>Free:</strong> up to 5 products.</li><li><strong>Basic:</strong> up to 50 products.</li><li><strong>Pro:</strong> unlimited products.</li></ul>
<p>StoreMink enforces the allowance on every new product, including CSV imports. A downgrade never deletes, hides, unpublishes, or blocks edits to existing products. If the current count is above the active plan limit, all existing products stay available and only creation is paused until the store upgrades or the count falls below the limit.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'add-or-edit-a-product'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      replace(body, 'Top-ups are available on Basic and Pro.', 'Top-ups are available on Free, Basic, and Pro.'),
      'Check that the store is on Basic or Pro before buying credits.',
      'Credit packs can be bought on Free, Basic, or Pro when StoreMink credit payments are available.'
    ),
    updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(body, '<h2>Create a group</h2>', '<p><strong>Plan availability:</strong> Customer groups are available on Basic and Pro. On Free, existing groups, memberships, and coupon links are retained but cannot be changed until an upgrade.</p><h2>Create a group</h2>'),
    updated_at = now()
WHERE slug = 'create-and-manage-customer-groups'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(body, '<p>Customer submissions are optional.', '<p><strong>Plan availability:</strong> Customer blog submissions are available on Basic and Pro. A move to Free pauses writing and access without deleting customer drafts or submissions; access returns after an upgrade.</p><p>Customer submissions are optional.'),
    updated_at = now()
WHERE slug = 'allow-and-review-customer-blog-submissions'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(body, '<h2>Enable custom code</h2>', '<p><strong>Plan availability:</strong> Custom-code sections are available on Basic and Pro. On Free, saved code stays in the page record but does not run on the storefront; upgrading restores it.</p><h2>Enable custom code</h2>'),
    updated_at = now()
WHERE slug = 'add-safe-custom-code-to-a-page'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(body, '<p>StoreMink connects to a Shiprocket account owned by your business.', '<p><strong>Plan availability:</strong> Shiprocket is available on Basic and Pro. A move to Free pauses new provider operations but retains the encrypted connection, warehouse mappings, and shipment history for a later upgrade.</p><p>StoreMink connects to a Shiprocket account owned by your business.'),
    updated_at = now()
WHERE slug = 'connect-shiprocket-and-sync-warehouses'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      '<p>The core Analytics dashboard is available according to your StoreMink plan and the features enabled by StoreMink. Advanced integrations such as Google Analytics 4 and Meta Pixel are <strong>Pro plan</strong> features.',
      '<p>The core Analytics dashboard is available on every plan. Dashboard customization, detailed reports, CSV exports, and Search Console analytics require Basic or Pro. Saved layouts remain stored on Free and return after an upgrade. Google Analytics 4, Meta Pixel, storefront conversion, and gross-margin analytics are <strong>Pro plan</strong> features.'
    ),
    updated_at = now()
WHERE slug = 'understand-analytics-dashboard'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'manage-your-storemink-plan-and-subscription'
      AND body LIKE '%<td>5</td><td>50</td><td>Unlimited</td>%'
      AND body LIKE '%does not delete store data because a plan becomes lower%'
  ) THEN
    RAISE EXCEPTION 'plan entitlement Help guide was not updated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'add-or-edit-a-product'
      AND body LIKE '%<strong>Free:</strong> up to 5 products.%'
      AND body LIKE '%CSV imports%'
  ) THEN
    RAISE EXCEPTION 'product limit Help guide was not updated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'allow-and-review-customer-blog-submissions'
      AND body LIKE '%available on Basic and Pro%'
  ) THEN
    RAISE EXCEPTION 'customer blog entitlement Help guide was not updated';
  END IF;
END $$;
