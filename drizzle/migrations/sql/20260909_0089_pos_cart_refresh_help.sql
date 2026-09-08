-- The register now keeps the in-progress basket in the browser tab, so a
-- reload no longer empties the cart mid-sale. Document what it does and does
-- not survive, so the difference from Hold stays clear: Hold is the durable,
-- shared-with-the-counter version, this is a same-tab safety net.
--
-- Forward-only: the original POS guide migration (20260825_0015) is untouched
-- and every sentence here is appended in place, so operator edits elsewhere in
-- the article survive.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Take payment and complete</h2>',
      $refresh$<h2>If the register page reloads</h2>
<p>An in-progress sale is kept in the browser tab it was started in, so reloading the register — or coming back to it after browsing another POS screen — restores the selected products, quantities, line discounts, order discount and GSTIN. The cart shows <strong>Restoring the sale in progress…</strong> for a moment while it reloads.</p>
<p>Like a held sale, only the choices are kept: StoreMink applies current prices and live stock when the basket comes back, and a product deleted meanwhile is dropped with a notice. The attached customer and receipt email are not kept — enter the mobile again at <strong>Charge</strong>.</p>
<p>This safety net is limited to the same browser tab, and it is cleared when the till locks or anyone signs out, because the basket must not be waiting for whoever signs in next. It is also cleared after 12 hours, and it is not shared between locations or between two register tabs. To keep a sale across a lock, a different till or a longer break, use <strong>Hold sale</strong> instead — a held sale is saved to your store, not to the browser. If your browser blocks site data, the register still works normally; only this reload safety net is unavailable.</p>
<h2>Take payment and complete</h2>$refresh$
    ),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale'
  AND status = 'published'
  AND body NOT LIKE '%<h2>If the register page reloads</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'process-an-in-store-sale'
      AND status = 'published'
      AND body LIKE '%<h2>If the register page reloads</h2>%'
      AND body LIKE '%kept in the browser tab it was started in%'
      AND body LIKE '%cleared when the till locks or anyone signs out%'
      AND body LIKE '%a held sale is saved to your store, not to the browser%'
  ) THEN
    RAISE EXCEPTION 'POS cart reload guidance was not installed';
  END IF;
END $$;
