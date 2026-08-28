-- Document how a refunded sale now appears in the POS Sales list, and that a
-- fully refunded one no longer offers a return. Forward-only: 0033 and the
-- earlier POS Help revisions remain immutable migration history.
--
-- The badge previously read `orders.status`, which only became "refunded"
-- because the till wrote it — so once counter refunds moved onto the shared
-- money core, a fully refunded sale rendered as untouched and kept a live
-- "Return items" link. It reads the derived payment status now, and tells a
-- partial refund apart from a full one.

UPDATE public.help_articles
SET body = body || $append$
<h2>See what has already been refunded</h2>
<p>A sale in <strong>Sales</strong> carries a label when money has gone back. <strong>Refunded</strong> means the whole sale has been returned; <strong>Partly refunded</strong> means some of it has, and the rest can still come back. <strong>Cancelled</strong> is separate and means the sale was undone rather than refunded.</p>
<p><strong>Return items</strong> disappears only on a cancelled sale and on one that is fully refunded, because there is nothing left to take back. It stays available on a partly refunded sale so the remaining items can be returned later.</p>
<p>These labels follow refunds that have actually settled. A gateway refund that fails is removed again, so a sale can correctly stop showing as refunded.</p>$append$,
    updated_at = now()
WHERE slug = 'view-pos-sales-shifts-money-and-analytics'
  AND status = 'published'
  AND body NOT LIKE '%<h2>See what has already been refunded</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'view-pos-sales-shifts-money-and-analytics'
      AND status = 'published'
      AND body LIKE '%<h2>See what has already been refunded</h2>%'
      AND body LIKE '%Partly refunded%'
  ) THEN
    RAISE EXCEPTION 'POS Sales refund-state guidance was not published';
  END IF;
END $$;
