-- Keep the published register guide aligned with the phone and portrait-tablet
-- Sell layout. Forward-only: the original POS guide migration remains intact.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Understand unavailable products</h2>',
      $mobile$<h2>Use the register on a phone or portrait tablet</h2>
<p>On a smaller screen, <strong>Products</strong> and <strong>Cart</strong> are separate full-width views so product names, photos and checkout controls do not become narrow strips. Add as many products as needed from Products; the cart count and total stay visible at the bottom. Select <strong>View cart</strong> or <strong>Cart</strong> to review quantities, discounts and the total, then select <strong>Products</strong> to add more. On a wider till, the product grid and cart remain side by side.</p>
<p>Managers and owners can select the grid icon beside the Products and Cart switch to edit the product layout. Finish or close layout editing before opening the cart.</p>
<h2>Understand unavailable products</h2>$mobile$
    ),
    updated_at = now()
WHERE slug = 'customize-register-and-scan-products'
  AND status = 'published'
  AND body NOT LIKE '%<h2>Use the register on a phone or portrait tablet</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'customize-register-and-scan-products'
      AND status = 'published'
      AND body LIKE '%<h2>Use the register on a phone or portrait tablet</h2>%'
      AND body LIKE '%<strong>Products</strong> and <strong>Cart</strong> are separate full-width views%'
      AND body LIKE '%the product grid and cart remain side by side%'
  ) THEN
    RAISE EXCEPTION 'POS mobile register guidance was not installed';
  END IF;
END $$;
