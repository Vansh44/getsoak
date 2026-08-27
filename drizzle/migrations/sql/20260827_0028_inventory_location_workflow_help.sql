-- Document the location-first inventory workspace and the product-editor stock handoff.
-- Forward-only Help Centre update: never rewrite an applied migration.

UPDATE public.help_articles
SET body = $article$<h2>Turn on tracking for a simple product</h2>
<ol><li>Open a product that has no variants and select <strong>Inventory</strong>.</li><li>Turn on <strong>Track quantity for this product</strong>.</li><li>Choose whether to continue selling when out of stock.</li><li>Enter a product-specific low-stock threshold, or leave 0 to use the store default.</li><li>Save the product.</li><li>Return to the product's Inventory tab and select <strong>Manage stock by location</strong>, or open <strong>Products → Inventory</strong>.</li><li>Confirm the stock location shown at the top, then set its counted quantity.</li></ol>
<h2>Products with variants</h2>
<p>When a product has variants, each variant is the stock unit shown in Inventory. A new variant accepts opening stock, which is placed at the main location. Existing variant stock is a read-only store-wide total in the product form; select <strong>Manage by location</strong> to change the correct shelf. The current editor does not expose per-variant tracking, backorder, or low-stock-threshold controls.</p>
<h2>Understand the quantities</h2>
<ul><li><strong>On hand</strong> is the physical quantity recorded at the location.</li><li><strong>Reserved</strong> is stock held for orders that have not released or completed the reservation.</li><li><strong>Available</strong> is on hand minus reserved.</li></ul>
<h2>Allow backorders</h2>
<p>For a simple product, turn on backorders only when you are prepared to accept an order beyond available stock. StoreMink still shows and records the resulting stock position, but fulfilment is your responsibility.</p>
<h2>Checkout safety</h2>
<p>The storefront limits quantities using the current availability and rechecks price, stock, coupon, tax, and shipping at checkout. A stale cart is corrected before an order is completed.</p>$article$,
    updated_at = now()
WHERE slug = 'track-inventory-and-allow-backorders'
  AND status = 'published';

UPDATE public.help_articles
SET body = $article$<h2>Start at the shelf you are counting</h2>
<ol><li>Open <strong>Products → Inventory</strong>. A multi-location store opens on its main or first accessible location.</li><li>Check the <strong>Stock location</strong> panel at the top. It names the shop or warehouse affected by every edit on the page.</li><li>Choose another location when needed, then search for the product or SKU.</li></ol>
<p><strong>All locations (view only)</strong> is an explicit store-wide comparison for staff with access to every location. It shows totals, but its rows do not open the stock editor and bulk changes are unavailable. Location-bound staff stay on their assigned shelves and do not receive the store-wide aggregate. Choose a physical location before changing stock.</p>
<h2>Set the stock level</h2>
<ol><li>Select the item row to open <strong>Manage stock at [location]</strong>.</li><li>Enter the exact stock level, or use the minus, plus, and quick-adjust buttons to calculate the new level.</li><li>Choose the reason.</li><li>Select <strong>Save stock</strong>. Only the named location changes.</li></ol>
<h2>Adjust several items</h2>
<p>Select multiple rows and choose the bulk stock action when they should all receive the same exact stock level at the location named in the confirmation. This is an absolute Set operation, not a separate amount added to or subtracted from every item.</p>
<h2>Move between locations and inventory</h2>
<p>Open <strong>Locations</strong> to manage a shop's details, capabilities, fulfilment, and pickup. Select <strong>View inventory</strong> on a location card or editor to return directly to that location's stock. Use <strong>Manage locations</strong> in Inventory to go the other way.</p>
<h2>Only on-hand stock is editable</h2>
<p>The Inventory screen changes on-hand stock. Orders control reservations, and available stock is calculated from on hand minus reserved. Correct the order lifecycle instead of trying to overwrite a reservation. Every saved change writes a ledger movement so the history remains explainable.</p>$article$,
    updated_at = now()
WHERE slug = 'adjust-stock-at-a-location'
  AND status = 'published';

UPDATE public.help_articles
SET body = $article$<h2>Set store-wide defaults</h2>
<p>Open <strong>Products → Inventory</strong> and select <strong>Settings</strong>.</p>
<ol><li>Choose whether newly created simple products should track inventory by default.</li><li>Set the store-wide low-stock threshold.</li><li>Save.</li></ol>
<h2>Override one simple product</h2>
<p>For a product without variants, open its <strong>Inventory</strong> tab and enter a product-specific threshold when it needs an earlier or later warning. Enter 0 to use the store default. The current editor does not expose this override for an individual variant.</p>
<h2>Find low stock</h2>
<p>Use the low-stock badge or filter in Inventory. Confirm the named stock location before ordering or moving stock because one store-wide total can hide a shortage at a particular shop.</p>
<h2>Read location history</h2>
<p>At a specific location, select an item and then choose <strong>History</strong>. The drawer is filtered to that location and names it at the top. Each entry shows the reason, timestamp, quantity delta, location, order ID when present, note or “System Update”, and balance after the movement. The operator identifier is recorded in the ledger but is not currently displayed in this drawer.</p>$article$,
    updated_at = now()
WHERE slug = 'set-low-stock-defaults-and-read-stock-history'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        '<p>The Stock field sets the starting quantity for a new variant. Changing that field on an existing variant does not update inventory; open <strong>Products → Inventory</strong> and change stock at the correct location instead. Variant gallery images can be added or removed, but cannot currently be rearranged.</p>',
        '<p>The Stock field sets opening stock for a new variant at the main location. Existing variant stock appears as a read-only store-wide total, with a <strong>Manage by location</strong> link to Inventory; it cannot be changed in the product form. Variant gallery images can be added or removed, but cannot currently be rearranged.</p>'
      ),
      '<li>Enter its base and selling prices, optional sale price, initial stock, supplier barcode, and images. Cost appears only when gross margin is available for the store.</li>',
      '<li>Enter its base and selling prices, optional sale price, opening stock, supplier barcode, and images. Cost appears only when gross margin is available for the store.</li>'
    ),
    updated_at = now()
WHERE slug = 'add-product-images-and-variants'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'track-inventory-and-allow-backorders'
      AND body LIKE '%select <strong>Inventory</strong>%'
      AND body LIKE '%Existing variant stock is a read-only store-wide total%'
  ) THEN
    RAISE EXCEPTION 'product inventory workflow guidance was not updated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'adjust-stock-at-a-location'
      AND body LIKE '%All locations (view only)%'
      AND body LIKE '%rows do not open the stock editor%'
      AND body LIKE '%View inventory%'
  ) THEN
    RAISE EXCEPTION 'location-first stock adjustment guidance was not updated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'set-low-stock-defaults-and-read-stock-history'
      AND body LIKE '%drawer is filtered to that location%'
      AND body LIKE '%select <strong>Settings</strong>%'
  ) THEN
    RAISE EXCEPTION 'inventory settings and history guidance was not updated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'add-product-images-and-variants'
      AND body LIKE '%read-only store-wide total%'
      AND body LIKE '%opening stock for a new variant at the main location%'
  ) THEN
    RAISE EXCEPTION 'variant stock guidance was not updated';
  END IF;
END $$;
