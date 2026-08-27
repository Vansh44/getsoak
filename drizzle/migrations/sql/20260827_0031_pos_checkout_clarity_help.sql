-- Keep the POS checkout, customer and tender guides aligned with the simplified
-- checkout flow. Forward-only: the original published migration remains intact.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Attach an existing customer</h2>
<ol><li>Open <strong>Customer</strong> from the cart.</li><li>Search by name, mobile number, or email.</li><li>Select the correct customer.</li></ol>
<p>Attaching the customer puts the receipt in their in-store order history and makes their store-credit balance available.</p>
<h2>Add a new walk-in customer</h2>
<p>If search finds nobody, select <strong>Add as a new customer</strong>. Enter a name and mobile number; email is optional. The new customer is attached immediately. If that person later signs up online using the same mobile number, StoreMink can connect the earlier in-store history and store credit to the new account.</p>$old$,
      $new$<h2>Add customer details at checkout</h2>
<ol><li>Select <strong>Charge</strong> after reviewing the cart.</li><li>On the Checkout screen, select <strong>Add customer</strong>.</li><li>Search by name, mobile number, or email and select the correct customer.</li></ol>
<p>The checkout shows the attached customer's name and contact details before payment. Attaching the customer puts the receipt in their in-store order history and makes their store-credit balance available. Customer details are recommended, not required: select <strong>Continue as walk-in</strong> when the shopper does not want a profile.</p>
<h2>Create a new customer</h2>
<p>Search and <strong>Create new customer</strong> are on the same screen. Enter a name and mobile number; email is optional. StoreMink attaches the new customer immediately. If that person later signs up online using the same mobile number, StoreMink can connect the earlier in-store history and store credit to the new account. If the mobile is already on file, StoreMink attaches the existing customer instead of creating a duplicate.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Take payment and complete</h2>
<ol><li>Select <strong>Take payment</strong>.</li><li>Choose one payment method, or turn on split payment.</li><li>Confirm the amount received and any change.</li><li>Complete the sale.</li><li>Print the receipt or start a new sale.</li></ol>$old$,
      $new$<h2>Take payment and complete</h2>
<ol><li>Select <strong>Charge</strong>.</li><li>Add a customer or continue as a walk-in, then select <strong>Continue to payment</strong>.</li><li>Choose the payment method that matches what happened.</li><li>For cash, enter the amount received and check the change. For a card terminal or UPI / QR, confirm the payment on that device before recording it. Razorpay opens and verifies its own payment.</li><li>Complete the sale, then print the receipt or start a new sale.</li></ol>$new$
    ),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>The tender panel separates money StoreMink takes or verifies from money you record after using another device. Always choose the method that matches what actually happened.</p>
<h2>Payment methods</h2>
<table><thead><tr><th>Method</th><th>What it means</th></tr></thead><tbody><tr><td>Cash</td><td>Cash enters the drawer. You can enter more than the balance and StoreMink calculates change.</td></tr><tr><td>Card machine</td><td>The customer paid on your own card terminal. Complete that terminal payment first; StoreMink records it but cannot verify it.</td></tr><tr><td>UPI app</td><td>The customer paid through your own UPI app or QR. Confirm it in that app first; StoreMink records it but cannot verify it.</td></tr><tr><td>Online</td><td>StoreMink opens the connected Razorpay checkout and verifies the captured payment and amount before completing the sale.</td></tr><tr><td>Store credit</td><td>Uses the attached customer's available balance. It is a payment, not a discount.</td></tr></tbody></table>
<h2>Take one full payment</h2>
<p>Select the method. Card machine, UPI app, Online, and store credit use the remaining balance and can complete in one step. Cash lets you enter the amount handed over so the receipt can show change.</p>$old$,
      $new$<p>The Payment screen shows one plain list of methods. Choose the method that matches what happened; StoreMink then asks only for the confirmation that method needs.</p>
<h2>Payment methods</h2>
<table><thead><tr><th>Method</th><th>What it means</th></tr></thead><tbody><tr><td>Cash</td><td>Enter the cash received. StoreMink shows the change before the sale completes.</td></tr><tr><td>Card terminal</td><td>Complete the payment on your own terminal first, then record it in StoreMink. StoreMink cannot verify this terminal.</td></tr><tr><td>UPI / QR</td><td>Confirm the payment in your own UPI app or QR account first, then record it. StoreMink cannot verify this app.</td></tr><tr><td>Razorpay</td><td>StoreMink opens the connected Razorpay checkout and verifies the captured payment and amount.</td></tr><tr><td>Store credit</td><td>Uses the attached customer's available balance. It is a payment, not a discount.</td></tr></tbody></table>
<h2>Take one full payment</h2>
<p>Select one method. Card terminal and UPI / QR use the full amount due and ask for a clear confirmation after you check the external device. Razorpay opens its verified payment. Cash lets you enter the notes received and review change. Only methods available at this store appear.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'take-payments-and-split-tenders'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Split a payment</h2>
<ol><li>Turn on <strong>Split payment</strong>.</li><li>Select the first method and enter its amount.</li><li>Add it to the sale.</li><li>Select the next method and enter the remaining amount.</li><li>Continue until the balance is covered, then complete the sale.</li></ol>$old$,
      $new$<h2>Split a payment</h2>
<ol><li>Select <strong>Split payment</strong>.</li><li>Choose the first payment method.</li><li>Enter the amount paid that way and add it.</li><li>Review the payment and the amount still due.</li><li>Choose the next method and enter that part.</li><li>When the payment is complete, review all parts and select <strong>Complete sale</strong>.</li></ol>
<p>Store credit that is smaller than the amount due automatically follows this split flow: apply the available credit, then choose how to collect the remainder.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'take-payments-and-split-tenders'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      '<p>Attach the customer before opening the tender panel. Apply up to the available balance, then take the remainder by another method. The goods value and GST stay unchanged because credit settles money rather than reducing the selling price.</p>',
      '<p>Attach the customer in Checkout details. Store credit then appears as a payment method with the available balance. Apply up to that balance, then take the remainder by another method. The goods value and GST stay unchanged because credit settles money rather than reducing the selling price.</p>'
    ),
    updated_at = now()
WHERE slug = 'take-payments-and-split-tenders'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      '<p>On the tender panel, enter <strong>Email a receipt (optional)</strong> when no customer with an email is attached. An invalid address never blocks a completed sale; StoreMink skips the email and the paper receipt remains available. The box clears before the next customer.</p>',
      '<p>On the Checkout details screen, enter <strong>Receipt email (optional)</strong> when no customer with an email is attached. This sends the receipt only; it does not create a customer profile. An invalid address never blocks a completed sale; StoreMink skips the email and the paper receipt remains available. The box clears before the next customer.</p>'
    ),
    updated_at = now()
WHERE slug = 'print-email-and-understand-pos-receipts'
  AND status = 'published';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'process-an-in-store-sale'
      AND status = 'published'
      AND body LIKE '%select <strong>Continue as walk-in</strong>%'
      AND body LIKE '%Search and <strong>Create new customer</strong> are on the same screen%'
  ) THEN
    RAISE EXCEPTION 'POS customer checkout guidance was not updated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'take-payments-and-split-tenders'
      AND status = 'published'
      AND body LIKE '%The Payment screen shows one plain list of methods%'
      AND body LIKE '%Choose the first payment method%'
      AND body LIKE '%automatically follows this split flow%'
  ) THEN
    RAISE EXCEPTION 'POS payment guidance was not updated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'print-email-and-understand-pos-receipts'
      AND status = 'published'
      AND body LIKE '%On the Checkout details screen%'
      AND body LIKE '%does not create a customer profile%'
  ) THEN
    RAISE EXCEPTION 'POS receipt guidance was not updated';
  END IF;
END $$;
