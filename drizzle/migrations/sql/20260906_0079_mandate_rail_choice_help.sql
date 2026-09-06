-- Document the renewal-rail choice on the plan page, and the one case where a
-- resumed payment window keeps the rail chosen earlier.
--
-- The authorisation order declares the mandate rail, and the rail cannot be
-- edited after that order exists. Merchants now pick card or UPI Autopay before
-- Checkout opens, so the guide has to say what the choice means and why a
-- resumed window can still show the earlier one.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Change, cancel, or resume a plan</h2>',
      $rail$<h2>Choose how renewals are charged</h2>
<p>Before Checkout opens you choose the rail your autopay mandate is registered on. The choice applies to the first payment and to every renewal after it.</p>
<ul><li><strong>Card</strong> &mdash; renewals are debited from a credit or debit card you authorise once.</li><li><strong>UPI Autopay</strong> &mdash; renewals are debited from a UPI app you approve once. Choose this if you would rather not keep a card on file.</li></ul>
<p>The payment window only offers the rail you picked, because the authorisation is created for that rail specifically. <strong>The rail cannot be changed after a mandate is authorised</strong>; to move to the other one, cancel the subscription and subscribe again.</p>
<p>If you close the payment window without paying and come back, StoreMink reopens the same window rather than creating a second one, so you are never charged twice. If you pick a different rail at that point you get the new one, unless a payment has already been tried in the old window &mdash; in which case the earlier rail is kept and a message on screen says so.</p>
<h2>Change, cancel, or resume a plan</h2>$rail$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Choose how renewals are charged</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'manage-your-storemink-plan-and-subscription'
      AND status = 'published'
      AND body LIKE '%<h2>Choose how renewals are charged</h2>%'
      AND body LIKE '%UPI Autopay%'
      AND body LIKE '%cannot be changed after a mandate is authorised%'
  ) THEN
    RAISE EXCEPTION 'Mandate rail guidance was not installed';
  END IF;
END $$;
