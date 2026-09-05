-- Document the billing contact a subscription needs before Razorpay autopay can
-- be prepared, and how to correct the refusal that names it.
--
-- Every paid StoreMink subscription registers an autopay mandate on its first
-- payment, and Razorpay's recurring endpoint needs BOTH an email address and a
-- mobile number for the payer. StoreMink refuses before Checkout when it cannot
-- find both, so a merchant may meet that refusal with no money taken and no
-- explanation of which field is missing. The plan guide now states the
-- requirement and where the two values live.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Change, cancel, or resume a plan</h2>',
      $autopay$<h2>What a paid plan needs before you can pay</h2>
<p>A paid plan is an autopay subscription, so the first payment also authorises future renewals. StoreMink needs a <strong>billing email address</strong> and an Indian <strong>mobile number</strong> for the store before it can open that authorisation, because the payment provider sends the pre-debit notice to them.</p>
<ul><li>Both are saved during signup from the email and phone number you verified.</li><li>You can review or correct them at any time under <strong>Settings &rarr; Taxes &amp; invoices</strong>, in the store contact fields.</li><li>The mobile number must be a ten-digit Indian mobile. A landline or an incomplete number is not accepted.</li><li>Your own verified number under <strong>Settings &rarr; Account</strong> is used first when it is present.</li></ul>
<p>If Subscribe reports that autopay could not be prepared, add or correct those two fields and try again. <strong>No payment is taken when that message appears</strong>, so nothing is charged twice by retrying.</p>
<h2>Change, cancel, or resume a plan</h2>$autopay$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription'
  AND status = 'published'
  AND body NOT LIKE '%<h2>What a paid plan needs before you can pay</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'manage-your-storemink-plan-and-subscription'
      AND status = 'published'
      AND body LIKE '%<h2>What a paid plan needs before you can pay</h2>%'
      AND body LIKE '%Taxes &amp; invoices%'
      AND body LIKE '%No payment is taken when that message appears%'
  ) THEN
    RAISE EXCEPTION 'Subscription autopay contact guidance was not installed';
  END IF;
END $$;
