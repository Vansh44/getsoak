-- Correct the POS checkout guide to the submit-only phone flow and document
-- mandatory customer OTP verification for pickup hand-over and till returns.
-- Forward-only: 0031 remains an immutable record of the previous UI.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Add customer details at checkout</h2>
<ol><li>Select <strong>Charge</strong> after reviewing the cart.</li><li>On the Checkout screen, select <strong>Add customer</strong>.</li><li>Search by name, mobile number, or email and select the correct customer.</li></ol>
<p>The checkout shows the attached customer's name and contact details before payment. Attaching the customer puts the receipt in their in-store order history and makes their store-credit balance available. Customer details are recommended, not required: select <strong>Continue as walk-in</strong> when the shopper does not want a profile.</p>
<h2>Create a new customer</h2>
<p>Search and <strong>Create new customer</strong> are on the same screen. Enter a name and mobile number; email is optional. StoreMink attaches the new customer immediately. If that person later signs up online using the same mobile number, StoreMink can connect the earlier in-store history and store credit to the new account. If the mobile is already on file, StoreMink attaches the existing customer instead of creating a duplicate.</p>$old$,
      $new$<h2>Identify the customer by mobile</h2>
<ol><li>Select <strong>Charge</strong> after reviewing the cart.</li><li>Enter the customer's 10-digit mobile number. The box accepts digits only.</li><li>Select <strong>OK</strong>.</li></ol>
<p>StoreMink does not search while you type. Selecting OK performs one exact lookup. If the mobile already belongs to a customer, their saved name, email and available store credit appear on the Payment screen. If it is new, StoreMink creates and attaches a phone-only customer automatically. Both routes go straight to Payment without another Continue step.</p>
<p>Check the displayed customer before taking money. Select <strong>Change</strong> to submit a different mobile before the first payment is added. A customer created at the till can connect their in-store history and store credit when they later sign up online with the same verified mobile.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Take payment and complete</h2>
<ol><li>Select <strong>Charge</strong>.</li><li>Add a customer or continue as a walk-in, then select <strong>Continue to payment</strong>.</li><li>Choose the payment method that matches what happened.</li><li>For cash, enter the amount received and check the change. For a card terminal or UPI / QR, confirm the payment on that device before recording it. Razorpay opens and verifies its own payment.</li><li>Complete the sale, then print the receipt or start a new sale.</li></ol>$old$,
      $new$<h2>Take payment and complete</h2>
<ol><li>Select <strong>Charge</strong>, enter the customer's 10-digit mobile, and select <strong>OK</strong>.</li><li>Check the resolved customer on the Payment screen.</li><li>Choose the payment method that matches what happened.</li><li>For cash, enter the amount received and check the change. For a card terminal or UPI / QR, confirm the payment on that device before recording it. Razorpay opens and verifies its own payment.</li><li>Complete the sale, then print the receipt or start a new sale.</li></ol>
<p>Receipt email and GSTIN are optional. Expand <strong>Add receipt email or GSTIN</strong> only when they are needed; they do not add another customer-lookup step.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      '<p>Attach the customer in Checkout details. Store credit then appears as a payment method with the available balance. Apply up to that balance, then take the remainder by another method. The goods value and GST stay unchanged because credit settles money rather than reducing the selling price.</p>',
      '<p>Submit the customer''s mobile before Payment. StoreMink loads any available store credit with the matching customer and shows it as a payment method. Apply up to that balance, then take the remainder by another method. The goods value and GST stay unchanged because credit settles money rather than reducing the selling price.</p>'
    ),
    updated_at = now()
WHERE slug = 'take-payments-and-split-tenders'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      '<p>On the Checkout details screen, enter <strong>Receipt email (optional)</strong> when no customer with an email is attached. This sends the receipt only; it does not create a customer profile. An invalid address never blocks a completed sale; StoreMink skips the email and the paper receipt remains available. The box clears before the next customer.</p>',
      '<p>On the Payment screen, expand <strong>Add receipt email or GSTIN</strong> and enter <strong>Receipt email (optional)</strong> when needed. This sends the receipt only; it does not create or change a customer profile. An invalid address never blocks a completed sale; StoreMink skips the email and the paper receipt remains available. The box clears before the next customer.</p>'
    ),
    updated_at = now()
WHERE slug = 'print-email-and-understand-pos-receipts'
  AND status = 'published';

UPDATE public.help_articles
SET body = body || $append$
<h2>Verify the customer before hand-over</h2>
<p>Before StoreMink opens payment or releases a parcel, it sends a six-digit OTP to the mobile saved on that order. Confirm the masked number with the customer and enter the code; verification continues automatically after the sixth digit. The same recent verification covers payment and hand-over for that order, but cannot be used for another order, shop, operator, or return.</p>
<p>A wrong or expired code leaves the parcel and payment unchanged. Use <strong>Resend code</strong> for a fresh code. If the order has no valid mobile, too many codes were requested, or phone verification is not configured, StoreMink blocks hand-over and explains the issue; there is no till override.</p>$append$,
    updated_at = now()
WHERE slug = 'prepare-and-hand-over-pickup-orders'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Verify the customer before hand-over</h2>%';

UPDATE public.help_articles
SET body = body || $append$
<h2>Verify the customer before completing a return</h2>
<p>After choosing items, restock decisions and the refund method, select the final refund action. StoreMink sends a six-digit OTP to the mobile saved on that order. Entering the sixth digit verifies automatically and submits the prepared return; you do not need to select Refund again.</p>
<p>A wrong, expired or cancelled code leaves the prepared return on screen and does not move stock or money. Use <strong>Resend code</strong> for a fresh code. If the order has no valid mobile, too many attempts were made, or phone verification is unavailable, the return cannot be completed at the till.</p>$append$,
    updated_at = now()
WHERE slug = 'take-returns-at-the-counter'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Verify the customer before completing a return</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'process-an-in-store-sale'
      AND status = 'published'
      AND body LIKE '%StoreMink does not search while you type.%'
      AND body LIKE '%go straight to Payment without another Continue step.%'
      AND body NOT LIKE '%select <strong>Continue as walk-in</strong>%'
  ) THEN
    RAISE EXCEPTION 'POS phone-first checkout guidance was not updated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'prepare-and-hand-over-pickup-orders'
      AND status = 'published'
      AND body LIKE '%<h2>Verify the customer before hand-over</h2>%'
      AND body LIKE '%there is no till override.%'
  ) THEN
    RAISE EXCEPTION 'POS pickup OTP guidance was not updated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'take-returns-at-the-counter'
      AND status = 'published'
      AND body LIKE '%<h2>Verify the customer before completing a return</h2>%'
      AND body LIKE '%does not move stock or money.%'
  ) THEN
    RAISE EXCEPTION 'POS return OTP guidance was not updated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'print-email-and-understand-pos-receipts'
      AND status = 'published'
      AND body LIKE '%expand <strong>Add receipt email or GSTIN</strong>%'
      AND body LIKE '%does not create or change a customer profile.%'
  ) THEN
    RAISE EXCEPTION 'POS receipt guidance was not updated';
  END IF;
END $$;
