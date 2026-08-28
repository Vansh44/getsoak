-- Document the completed POS customer, cart, pickup-payment, unified Sales,
-- and policy-driven counter return/exchange flows. Forward-only: the previous
-- POS Help revisions remain immutable migration history.

UPDATE public.help_articles
SET body = body || $append$
<h2>Recognise items in the cart</h2>
<p>Each cart line keeps a small product photo beside its name, variant, quantity and price. Products without an image use a package placeholder, so the line remains easy to scan without changing the checkout steps.</p>$append$,
    updated_at = now()
WHERE slug = 'process-an-in-store-sale'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Recognise items in the cart</h2>%';

UPDATE public.help_articles
SET body = body || $append$
<h2>Use Razorpay at collection</h2>
<p>After the order mobile passes OTP, <strong>Razorpay</strong> appears with Cash, Card terminal, UPI / QR and Store credit when the store has a connected and enabled Razorpay account on an eligible plan. Selecting it opens the verified Razorpay payment window. If the option is absent, check Dashboard → Channels and the store plan; do not record an unverified online payment as another tender.</p>$append$,
    updated_at = now()
WHERE slug = 'prepare-and-hand-over-pickup-orders'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Use Razorpay at collection</h2>%';

UPDATE public.help_articles
SET body = replace(
      replace(
        replace(
          body,
          '<ol><li>Open <strong>Returns</strong> or find the order from <strong>Sales</strong>.</li><li>Search by order reference, receipt number, phone, or email.</li><li>Open the order and select <strong>Return items</strong>.</li><li>Choose each item and quantity being returned.</li><li>Mark damaged units as <strong>Do not restock</strong> when they cannot go back on sale.</li><li>Choose an available refund method and confirm.</li></ol>',
          '<ol><li>Open <strong>Returns</strong> or find the order from <strong>Sales</strong>.</li><li>Search by order reference, receipt number, customer name, mobile, or email.</li><li>Open the order and select <strong>Return items</strong>.</li><li>Choose only eligible items and quantities. StoreMink explains final-sale and expired-window lines instead of allowing them to be selected.</li><li>Choose the return reason when required and mark damaged units as <strong>Do not restock</strong>.</li><li>Review the policy deductions and the original refund destination.</li><li>Select <strong>Refund</strong>, or <strong>Exchange</strong> when exchanges are enabled, then verify the order mobile by OTP.</li></ol>'
        ),
        '<ul><li>A StoreMink online card payment goes back through the original gateway. The till does not offer cash for it.</li><li>A COD or counter-paid order may offer the allowed counter methods.</li><li>Store credit is offered only when a customer account is attached.</li><li>A cash refund reduces the current drawer''s expected cash.</li></ul>',
        '<ul><li>Cash returns to cash and reduces the current drawer''s expected cash.</li><li>Card terminal and UPI / QR payments are recorded back to the same external method.</li><li>Razorpay returns through the original gateway; the till never offers cash for it.</li><li>Store credit returns to the attached customer''s balance.</li><li>A split payment is refunded across its original tenders in proportion to what each one settled. The cashier cannot convert a card or credit leg into cash.</li><li>Only a legacy order with no usable tender record asks the manager to choose a supported counter refund method.</li></ul>'
      ),
      '<p>Turn on <strong>Accept returns</strong>, enable <strong>Accept online returns in your shops</strong>, and give this location the <strong>Accept returns</strong> capability. The manager can then search an eligible online order. It appears as <strong>Bought elsewhere</strong> so the source is clear.</p>',
      '<p>Turn on <strong>Accept returns</strong>, enable <strong>Accept online returns in your shops</strong>, and give this location the <strong>Accept returns</strong> capability. These additional gates apply to every website order, including one collected from this same shop. The manager can search by its order reference or attached customer contact; it appears as <strong>Bought elsewhere</strong> so the source is clear.</p>'
    ) || $append$
<h2>Apply the store return policy</h2>
<p>The store-wide <strong>Accept returns</strong> switch governs every new counter return. Product-level <strong>Final sale</strong>, the product or store return window, required reason, merchant-fault fee waiver, and restocking-fee percentage are rechecked by the server. A merchant-fault reason such as damaged, defective, wrong item or not as described waives the restocking deduction. Returning at a shop never adds return-postage fees.</p>
<h2>Exchange at the counter</h2>
<p>When <strong>Offer exchanges</strong> is enabled, select <strong>Exchange</strong> before OTP. StoreMink records the return and its original-method refund first, then opens Sell with the same customer attached and locked. Add any replacement product and take payment through the normal tender flow. The return links to the replacement order, so the old sale, money returned and new sale remain auditable. If the replacement is abandoned, the completed return and refund remain valid; open Sell again only when the customer still wants a replacement.</p>$append$,
    updated_at = now()
WHERE slug = 'take-returns-at-the-counter'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Exchange at the counter</h2>%';

UPDATE public.help_articles
SET body = replace(
      body,
      '<p>A walk-in with no customer attached cannot receive store credit. Attach or create the customer before the original sale whenever they may need account-based after-sales support.</p>',
      '<p>Every new register sale has a customer attached from the submitted mobile, so store credit and after-sales history have an owner. Historical walk-in sales without a customer still cannot receive store credit.</p>'
    ) || $append$
<h2>Exchange an item at the counter</h2>
<p>A manager can exchange an eligible POS or website purchase in store when the return policy and location permit it. The till records the return and original-method refund, then creates a linked replacement as an ordinary paid POS order. Because the replacement uses the normal Sell checkout, the customer may choose another product and settle its full current price with any available tender.</p>$append$,
    updated_at = now()
WHERE slug = 'refunds-store-credit-exchanges-and-credit-notes'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Exchange an item at the counter</h2>%';

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        '<ol><li>Open <strong>Sales</strong> from the POS menu.</li><li>Search recent sales from the current location.</li><li>Open a sale to view its receipt.</li><li>Reprint it, or start a return when your role allows returns.</li></ol>',
        '<ol><li>Open <strong>Sales</strong> from the POS menu.</li><li>Search register receipts and completed in-store pickup orders from the current location.</li><li>Open a row to see the customer contact, sale type, completion time, every item and quantity, subtotal, discount, tax, total and each tender.</li><li>Print the receipt, or start a return when your role and the return policy allow it.</li></ol>'
      ),
      '<p>When POS is enabled on Pro, Dashboard → Orders shows <strong>All orders</strong>, <strong>Website orders</strong>, and <strong>POS orders</strong>. A standard register sale shows Sold at location, cashier, customer or Walk-in, items, payments, and receipt. It does not show delivery or shipment controls because the goods were handed over at the register.</p>',
      '<p>When POS is enabled on Pro, Dashboard → Orders shows <strong>All orders</strong>, <strong>Website orders</strong>, and <strong>POS orders</strong>. A standard register sale shows Sold at location, cashier, attached customer, items, payments, and receipt. Walk-in appears only on a historical anonymous row. It does not show delivery or shipment controls because the goods were handed over at the register.</p>'
    ) || $append$
<h2>Understand collected pickups in Sales</h2>
<p>A website pickup joins POS Sales after it is handed over at this location. It is labelled <strong>Store pickup</strong> and uses its order reference when it has no POS receipt number. This records the completed shop sale in the same counter history without changing its website sales channel or duplicating the order.</p>$append$,
    updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Understand collected pickups in Sales</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'process-an-in-store-sale'
      AND status = 'published'
      AND body LIKE '%<h2>Recognise items in the cart</h2>%'
  ) THEN
    RAISE EXCEPTION 'POS cart image guidance was not published';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'prepare-and-hand-over-pickup-orders'
      AND status = 'published'
      AND body LIKE '%<h2>Use Razorpay at collection</h2>%'
      AND body LIKE '%verified Razorpay payment window%'
  ) THEN
    RAISE EXCEPTION 'POS pickup Razorpay guidance was not published';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'take-returns-at-the-counter'
      AND status = 'published'
      AND body LIKE '%split payment is refunded across its original tenders%'
      AND body LIKE '%<h2>Exchange at the counter</h2>%'
      AND body LIKE '%final-sale and expired-window lines%'
  ) THEN
    RAISE EXCEPTION 'POS return and exchange guidance was not published';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'view-pos-sales-shifts-money-and-analytics'
      AND status = 'published'
      AND body LIKE '%completed in-store pickup orders%'
      AND body LIKE '%<h2>Understand collected pickups in Sales</h2>%'
  ) THEN
    RAISE EXCEPTION 'POS unified Sales guidance was not published';
  END IF;
END $$;
