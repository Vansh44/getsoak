-- Document what happens when the plan or billing period changes before the
-- first payment is made.
--
-- Cycle 1's invoice is raised the first time a merchant opens the payment
-- window, and they may still change their mind. StoreMink now re-prices that
-- pending payment to the plan they end up on, and refuses to move the amount
-- underneath a payment that is genuinely still going through. Merchants meet
-- both behaviours directly, so both belong in the plan guide.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Change, cancel, or resume a plan</h2>',
      $repriced$<h2>Changing your mind before you pay</h2>
<p>You can go back and pick a different plan or billing period at any point before the first payment succeeds. The pending payment is <strong>re-priced to the plan you have just chosen</strong>, so the amount Razorpay asks for always matches the plan you end up on.</p>
<p>If a payment for your earlier choice is still going through, StoreMink asks you to finish it or wait a minute rather than changing the amount underneath it. <strong>Nothing is charged while that message is on screen.</strong> A payment you started and abandoned &mdash; a UPI request you never approved, for example &mdash; does not hold you up: the next attempt replaces it.</p>
<h2>Change, cancel, or resume a plan</h2>$repriced$
    ),
    updated_at = now()
WHERE slug = 'manage-your-storemink-plan-and-subscription'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Changing your mind before you pay</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'manage-your-storemink-plan-and-subscription'
      AND status = 'published'
      AND body LIKE '%<h2>Changing your mind before you pay</h2>%'
      AND body LIKE '%re-priced to the plan you have just chosen%'
      AND body LIKE '%Nothing is charged while that message is on screen%'
  ) THEN
    RAISE EXCEPTION 'Plan-change-before-payment guidance was not installed';
  END IF;
END $$;
