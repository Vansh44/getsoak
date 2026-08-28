-- Document the completed POS customer, cart, pickup-payment, unified Sales,
-- and policy-driven counter return/exchange flows. Forward-only: the previous
-- POS Help revisions remain immutable migration history.
--
-- ── ★★ ONE STATEMENT PER PASSAGE, EACH GUARDED ON ITS OWN RESULT ───────────
-- This began as one UPDATE per ARTICLE, chaining several replace() calls and
-- an append behind a single `body NOT LIKE '<h2>…'` guard. That is not
-- idempotent in the way it looks: replace() has no "did it match?" signal, so
-- a source string that has drifted returns the body unchanged and the append
-- beside it still lands. The article then satisfies the guard while missing a
-- passage — and because the guard keys off the APPENDED heading, every later
-- run skips the row, so the missing passage can never be repaired by
-- re-running. It surfaced as a bare "guidance was not published" eleven
-- statements later, with nothing saying which passage was absent.
--
-- Each passage is now its own statement, guarded by the marker IT produces, so
-- a re-run repairs exactly what is missing and touches nothing else. The
-- verification block below reports every missing passage at once, names it,
-- and distinguishes "not applied yet" from "the seeded text was edited in the
-- Help console, so this rewrite can no longer match" — which no amount of
-- re-running will fix, and which needs a human in the console.

-- Cart line images.
UPDATE public.help_articles
SET body = body || $append$
<h2>Recognise items in the cart</h2>
<p>Each cart line keeps a small product photo beside its name, variant, quantity and price. Products without an image use a package placeholder, so the line remains easy to scan without changing the checkout steps.</p>$append$,
    updated_at = now()
WHERE slug = 'process-an-in-store-sale'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Recognise items in the cart</h2>%';

-- Razorpay at the collection counter.
UPDATE public.help_articles
SET body = body || $append$
<h2>Use Razorpay at collection</h2>
<p>After the order mobile passes OTP, <strong>Razorpay</strong> appears with Cash, Card terminal, UPI / QR and Store credit when the store has a connected and enabled Razorpay account on an eligible plan. Selecting it opens the verified Razorpay payment window. If the option is absent, check Dashboard → Channels and the store plan; do not record an unverified online payment as another tender.</p>$append$,
    updated_at = now()
WHERE slug = 'prepare-and-hand-over-pickup-orders'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Use Razorpay at collection</h2>%';

-- Counter return steps: eligibility, reason, deductions, OTP.
UPDATE public.help_articles
SET body = replace(
      body,
      '<ol><li>Open <strong>Returns</strong> or find the order from <strong>Sales</strong>.</li><li>Search by order reference, receipt number, phone, or email.</li><li>Open the order and select <strong>Return items</strong>.</li><li>Choose each item and quantity being returned.</li><li>Mark damaged units as <strong>Do not restock</strong> when they cannot go back on sale.</li><li>Choose an available refund method and confirm.</li></ol>',
      '<ol><li>Open <strong>Returns</strong> or find the order from <strong>Sales</strong>.</li><li>Search by order reference, receipt number, customer name, mobile, or email.</li><li>Open the order and select <strong>Return items</strong>.</li><li>Choose only eligible items and quantities. StoreMink explains final-sale and expired-window lines instead of allowing them to be selected.</li><li>Choose the return reason when required and mark damaged units as <strong>Do not restock</strong>.</li><li>Review the policy deductions and the original refund destination.</li><li>Select <strong>Refund</strong>, or <strong>Exchange</strong> when exchanges are enabled, then verify the order mobile by OTP.</li></ol>'
    ),
    updated_at = now()
WHERE slug = 'take-returns-at-the-counter'
  AND status = 'published'
  AND body NOT LIKE '%final-sale and expired-window lines%';

-- Where the money goes back, including split tenders.
UPDATE public.help_articles
SET body = replace(
      body,
      '<ul><li>A StoreMink online card payment goes back through the original gateway. The till does not offer cash for it.</li><li>A COD or counter-paid order may offer only the supported counter refund methods shown by the till.</li><li>The POS return flow does not offer store credit as a refund destination.</li><li>A cash refund reduces the current drawer''s expected cash.</li></ul>',
      '<ul><li>Cash returns to cash and reduces the current drawer''s expected cash.</li><li>Card terminal and UPI / QR payments are recorded back to the same external method.</li><li>Razorpay returns through the original gateway; the till never offers cash for it.</li><li>Store credit returns to the attached customer''s balance.</li><li>A split payment is refunded across its original tenders in proportion to what each one settled. The cashier cannot convert a card or credit leg into cash.</li><li>Only a legacy order with no usable tender record asks the manager to choose a supported counter refund method.</li></ul>'
    ),
    updated_at = now()
WHERE slug = 'take-returns-at-the-counter'
  AND status = 'published'
  AND body NOT LIKE '%split payment is refunded across its original tenders%';

-- BORIS gates, including a pickup collected at this same shop.
UPDATE public.help_articles
SET body = replace(
      body,
      '<p>Online returns at a shop work only when the store''s existing in-store-return policy is already active and the location has the <strong>Accept returns</strong> capability. The location capability is available under <strong>Locations</strong>, but the Returns settings group that controls the store-wide policy is not currently rendered in the merchant dashboard. If the workflow is unavailable, do not promise a counter return or look for a hidden switch; contact StoreMink support to confirm the account''s current configuration. When the prerequisites are already active, a manager can search an eligible online order. It appears as <strong>Bought elsewhere</strong> so the source is clear.</p>',
      '<p>Turn on <strong>Accept returns</strong>, enable <strong>Accept online returns in your shops</strong>, and give this location the <strong>Accept returns</strong> capability. These additional gates apply to every website order, including one collected from this same shop. The manager can search by its order reference or attached customer contact; it appears as <strong>Bought elsewhere</strong> so the source is clear.</p>'
    ),
    updated_at = now()
WHERE slug = 'take-returns-at-the-counter'
  AND status = 'published'
  AND body NOT LIKE '%These additional gates apply to every website order%';

-- Store return policy and the counter exchange flow.
UPDATE public.help_articles
SET body = body || $append$
<h2>Apply the store return policy</h2>
<p>The store-wide <strong>Accept returns</strong> switch governs counter returns of orders this till did not sell, and it turns on the return policy below. A sale rung at this same register stays returnable here even while the switch is off, exactly as it was before the switch existed — with no window, no required reason, no restocking fee and no exchange until you turn returns on. Product-level <strong>Final sale</strong>, the product or store return window, required reason, merchant-fault fee waiver, and restocking-fee percentage are rechecked by the server. A merchant-fault reason such as damaged, defective, wrong item or not as described waives the restocking deduction. Returning at a shop never adds return-postage fees.</p>
<h2>Exchange at the counter</h2>
<p>When <strong>Offer exchanges</strong> is enabled, select <strong>Exchange</strong> before OTP. StoreMink records the return and its original-method refund first, then opens Sell with the same customer attached and locked. Add any replacement product and take payment through the normal tender flow. The return links to the replacement order, so the old sale, money returned and new sale remain auditable. If the replacement is abandoned, the completed return and refund remain valid; open Sell again only when the customer still wants a replacement.</p>$append$,
    updated_at = now()
WHERE slug = 'take-returns-at-the-counter'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Exchange at the counter</h2>%';

-- Every register sale now has an owner for store credit.
UPDATE public.help_articles
SET body = replace(
      body,
      '<p>A walk-in with no customer attached cannot receive store credit. Attach or create the customer before the original sale whenever they may need account-based after-sales support.</p>',
      '<p>Every new register sale has a customer attached from the submitted mobile, so store credit and after-sales history have an owner. Historical walk-in sales without a customer still cannot receive store credit.</p>'
    ),
    updated_at = now()
WHERE slug = 'refunds-store-credit-exchanges-and-credit-notes'
  AND status = 'published'
  AND body NOT LIKE '%Every new register sale has a customer attached%';

-- Counter exchange, from the refunds guide.
UPDATE public.help_articles
SET body = body || $append$
<h2>Exchange an item at the counter</h2>
<p>A manager can exchange an eligible POS or website purchase in store when the return policy and location permit it. The till records the return and original-method refund, then creates a linked replacement as an ordinary paid POS order. Because the replacement uses the normal Sell checkout, the customer may choose another product and settle its full current price with any available tender.</p>$append$,
    updated_at = now()
WHERE slug = 'refunds-store-credit-exchanges-and-credit-notes'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Exchange an item at the counter</h2>%';

-- Sales screen steps: pickups, expanded detail, policy-aware returns.
UPDATE public.help_articles
SET body = replace(
      body,
      '<ol><li>Open <strong>Sales</strong> from the POS menu.</li><li>Search recent sales from the current location.</li><li>Open a sale to view its receipt.</li><li>Reprint it, or start a return when your role allows returns.</li></ol>',
      '<ol><li>Open <strong>Sales</strong> from the POS menu.</li><li>Search register receipts and completed in-store pickup orders from the current location.</li><li>Open a row to see the customer contact, sale type, completion time, every item and quantity, subtotal, discount, tax, total and each tender.</li><li>Print the receipt, or start a return when your role and the return policy allow it.</li></ol>'
    ),
    updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics'
  AND status = 'published'
  AND body NOT LIKE '%Search register receipts and completed in-store pickup orders%';

-- Dashboard Orders wording now that every register sale has a customer.
UPDATE public.help_articles
SET body = replace(
      body,
      '<p>When POS is enabled on Pro, Dashboard → Orders shows <strong>All orders</strong>, <strong>Website orders</strong>, and <strong>POS orders</strong>. A standard register sale shows Sold at location, cashier, customer or Walk-in, items, payments, and receipt. It does not show delivery or shipment controls because the goods were handed over at the register.</p>',
      '<p>When POS is enabled on Pro, Dashboard → Orders shows <strong>All orders</strong>, <strong>Website orders</strong>, and <strong>POS orders</strong>. A standard register sale shows Sold at location, cashier, attached customer, items, payments, and receipt. Walk-in appears only on a historical anonymous row. It does not show delivery or shipment controls because the goods were handed over at the register.</p>'
    ),
    updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics'
  AND status = 'published'
  AND body NOT LIKE '%Walk-in appears only on a historical anonymous row%';

-- Collected pickups joining POS Sales.
UPDATE public.help_articles
SET body = body || $append$
<h2>Understand collected pickups in Sales</h2>
<p>A website pickup joins POS Sales after it is handed over at this location. It is labelled <strong>Store pickup</strong> and uses its order reference when it has no POS receipt number. This records the completed shop sale in the same counter history without changing its website sales channel or duplicating the order.</p>$append$,
    updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Understand collected pickups in Sales</h2>%';


-- ── Verification ───────────────────────────────────────────────────────────
-- Reports EVERY missing passage at once, names the article and the passage,
-- and separates the two causes. A `replace()` whose source is gone cannot be
-- repaired by re-running, so saying so here is the difference between a
-- one-line console fix and an afternoon.
DO $$
DECLARE
  chk      record;
  article  text;
  problems text := '';
BEGIN
  FOR chk IN
    SELECT * FROM (VALUES
      -- slug, the marker this passage produces, a substring of the text it
      -- rewrites (NULL for an append, which has no source to drift).
      ('process-an-in-store-sale',
       '<h2>Recognise items in the cart</h2>', NULL),
      ('prepare-and-hand-over-pickup-orders',
       '<h2>Use Razorpay at collection</h2>', NULL),
      ('take-returns-at-the-counter',
       'final-sale and expired-window lines',
       '<li>Choose each item and quantity being returned.</li>'),
      ('take-returns-at-the-counter',
       'split payment is refunded across its original tenders',
       'The POS return flow does not offer store credit as a refund destination.'),
      ('take-returns-at-the-counter',
       'These additional gates apply to every website order',
       'the Returns settings group that controls the store-wide policy is not currently rendered'),
      ('take-returns-at-the-counter',
       '<h2>Exchange at the counter</h2>', NULL),
      ('refunds-store-credit-exchanges-and-credit-notes',
       'Every new register sale has a customer attached',
       'A walk-in with no customer attached cannot receive store credit.'),
      ('refunds-store-credit-exchanges-and-credit-notes',
       '<h2>Exchange an item at the counter</h2>', NULL),
      ('view-pos-sales-shifts-money-and-analytics',
       'Search register receipts and completed in-store pickup orders',
       '<li>Reprint it, or start a return when your role allows returns.</li>'),
      ('view-pos-sales-shifts-money-and-analytics',
       'Walk-in appears only on a historical anonymous row',
       'customer or Walk-in, items, payments, and receipt.'),
      ('view-pos-sales-shifts-money-and-analytics',
       '<h2>Understand collected pickups in Sales</h2>', NULL)
    ) AS t(slug, marker, source)
  LOOP
    SELECT body INTO article
      FROM public.help_articles
     WHERE slug = chk.slug AND status = 'published';

    IF article IS NULL THEN
      problems := problems || format(
        E'\n  - %s: no PUBLISHED article with this slug. Apply the earlier POS Help migrations first.',
        chk.slug);
    ELSIF position(chk.marker in article) = 0 THEN
      IF chk.source IS NOT NULL AND position(chk.source in article) = 0 THEN
        problems := problems || format(
          E'\n  - %s: the passage this migration rewrites is no longer present, so the rewrite cannot match. It was most likely edited in the Help console. Re-running will NOT fix it: restore the seeded wording, or apply the new text by hand. Expected result to contain: %s',
          chk.slug, chk.marker);
      ELSE
        problems := problems || format(
          E'\n  - %s: missing "%s".', chk.slug, chk.marker);
      END IF;
    END IF;
  END LOOP;

  IF problems <> '' THEN
    RAISE EXCEPTION E'POS Help 0033 did not fully apply:%', problems;
  END IF;
END $$;
