-- Phase 10: stable product cost basis and Pro gross-margin reporting.
-- Costs are nullable by design: unknown is never the same thing as zero.

ALTER TABLE public.products
  ADD COLUMN cost_price numeric(10,2),
  ADD CONSTRAINT products_cost_price_nonnegative
    CHECK (cost_price IS NULL OR cost_price >= 0);

ALTER TABLE public.product_variants
  ADD COLUMN cost_price numeric(10,2),
  ADD CONSTRAINT product_variants_cost_price_nonnegative
    CHECK (cost_price IS NULL OR cost_price >= 0);

ALTER TABLE public.order_items
  ADD COLUMN unit_cost numeric(12,2),
  ADD CONSTRAINT order_items_unit_cost_nonnegative
    CHECK (unit_cost IS NULL OR unit_cost >= 0);

COMMENT ON COLUMN public.products.cost_price IS
  'Merchant unit cost for future order-line snapshots; NULL means unknown.';
COMMENT ON COLUMN public.product_variants.cost_price IS
  'Optional variant unit cost; NULL inherits products.cost_price.';
COMMENT ON COLUMN public.order_items.unit_cost IS
  'Immutable unit cost snapshot. NULL means no cost was known when created/backfilled.';

UPDATE public.platform_analytics_settings
SET gross_margin = TRUE, updated_at = now()
WHERE id = TRUE;

INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT category.id,
       'understand-gross-margin-analytics',
       'Understand gross margin analytics',
       'Add product costs and understand cost coverage, cost of goods, gross profit, and gross margin in StoreMink.',
       '<p><strong>Pro feature:</strong> Gross margin analytics is available on Pro when StoreMink has enabled the module.</p><h2>Add product costs</h2><ol><li>Open <strong>Products</strong>.</li><li>Open a product and choose <strong>Pricing</strong>.</li><li>Enter <strong>Cost per unit</strong>, then save.</li></ol><p>For variants, add a variant cost only when it differs. A blank variant cost inherits the product cost.</p><h2>How historical backfill works</h2><p>The first cost you save fills older order lines only where no cost was recorded. Changing the cost later never rewrites an existing order-line snapshot; the new amount applies to future sales.</p><h2>Understand the figures</h2><p><strong>Costed sales</strong> is merchandise value for order lines with a known cost. <strong>Cost of goods</strong> is unit cost multiplied by units sold. <strong>Gross profit</strong> is costed sales minus cost of goods. <strong>Gross margin</strong> is gross profit divided by costed sales.</p><h2>Cost coverage</h2><p>Coverage shows how much merchandise value has a known cost. Missing costs are excluded rather than treated as zero. Add costs to products with missing values before relying on the margin.</p><h2>Scope</h2><p>The card follows the Analytics date and location filters and uses recognized online and POS order lines. The first release is before returns, refunds, shipping charges, tax, payment fees, and operating expenses, so it is a merchandise gross-margin view rather than accounting net profit.</p>',
       'published',
       'Understand gross margin analytics in StoreMink',
       'Learn how to add product costs and read cost coverage, COGS, gross profit, and gross margin in StoreMink Analytics.',
       12, now()
FROM public.help_categories AS category
WHERE category.slug = 'analytics'
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  body = EXCLUDED.body,
  status = 'published',
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  published_at = COALESCE(help_articles.published_at, now()),
  updated_at = now();
