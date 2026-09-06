-- Explain the switch that decides whether an automatic offer runs at all.
--
-- ★★ THE FAILURE THIS DOCUMENTS. `offers.autoApply` gates every offer whose
-- delivery is "automatically": with it off, the pricing engine refuses the
-- offer before it is ever valued, so the storefront and the till both charge
-- full price — while the Offers list shows the offer as plainly "Active" and
-- nothing anywhere reports an error. A merchant building their first
-- buy-1-get-1 had no way to find out.
--
-- Two product changes ship with this, and the guide has to describe both:
--   • New stores are created with automatic offers ON, so the switch is no
--     longer a hidden prerequisite for anyone starting today.
--   • Stores created BEFORE that keep the switch off — the setting defaults
--     off deliberately, so that a store which had only ever run discount CODES
--     could not wake up discounting by itself — and the dashboard now says so
--     on the offer editor and on the offers list, rather than reporting
--     "Active" for an offer that cannot fire.
--
-- Written into the guide because the second group is the one that hits it, and
-- they will search Help before they find a badge.
UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Best offer wins</h2>',
      $h$<h2>Automatic offers need to be switched on for your store</h2>
<p>An offer set to apply <strong>automatically</strong> only runs when your store allows automatic offers at all. Open <strong>Offers</strong> and look at <strong>How offers behave</strong> below the list: <strong>Apply offers automatically</strong> has to be on.</p>
<p><strong>Stores created recently already have it on.</strong> Older stores have it off, because before automatic offers existed every discount needed a code, and switching them on for an existing store without asking would have started giving discounts nobody had approved.</p>
<p>While it is off, an automatic offer is listed as <strong>Not applying</strong> rather than Active, and the offer editor says the same thing next to the delivery setting. Nothing is wrong with the offer itself — turn the switch on and it starts working immediately, online and at your till, with no other change.</p>
<p><strong>Offers with a discount code are never affected by this switch.</strong> A code a customer enters always works, so a store that only sends codes can leave automatic offers off.</p>
<h2>Best offer wins</h2>$h$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Automatic offers need to be switched on for your store</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'create-and-manage-offers'
      AND status = 'published'
      AND body LIKE '%<h2>Automatic offers need to be switched on for your store</h2>%'
      AND body LIKE '%Apply offers automatically%'
      AND body LIKE '%Not applying%'
      AND body LIKE '%never affected by this switch%'
  ) THEN
    RAISE EXCEPTION 'offers auto-apply guidance was not installed';
  END IF;
END $$;
