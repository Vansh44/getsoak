-- Platform Analytics controls and the first operator-editable Analytics help
-- documents. Availability is platform-global; plan entitlement remains in
-- application code so an enabled Pro feature cannot leak to lower plans.

CREATE TABLE public.platform_analytics_settings (
  id                      boolean PRIMARY KEY DEFAULT true,
  core_dashboard          boolean NOT NULL DEFAULT true,
  dashboard_customization boolean NOT NULL DEFAULT true,
  drilldown_reports       boolean NOT NULL DEFAULT true,
  google_search_console   boolean NOT NULL DEFAULT true,
  google_analytics_4      boolean NOT NULL DEFAULT false,
  meta_pixel              boolean NOT NULL DEFAULT false,
  storefront_conversion   boolean NOT NULL DEFAULT false,
  gross_margin            boolean NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              text,
  CONSTRAINT platform_analytics_settings_id_check CHECK (id)
);

ALTER TABLE public.platform_analytics_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_analytics_settings FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.platform_analytics_settings TO app_service;

INSERT INTO public.platform_analytics_settings (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

-- Help Centre content is deliberately created through the migration ledger so
-- staging and production begin with the same documentation. The live overview
-- describes shipped behaviour; integration guides remain drafts until those
-- collection modules ship.
INSERT INTO public.help_categories
  (slug, title, description, icon, position)
VALUES
  ('analytics', 'Analytics & reports',
   'Understand sales reports, Google Search data, exports, and advanced analytics.',
   'ChartNoAxesCombined', 9)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT category.id,
       'understand-analytics-dashboard',
       'Understand your Analytics dashboard',
       'Learn what StoreMink analytics measures, how to change the date range, customize cards, open reports, and export CSV files.',
       '<h2>Open Analytics</h2><p>From your StoreMink dashboard, select <strong>Analytics</strong>. The page combines sales, orders, products, customers, inventory, content, and Google Search information that your account can access.</p><h2>Choose a date range</h2><p>Use the date control at the top of the dashboard to choose a preset or custom period. StoreMink uses the business time zone selected in Settings when it decides where each calendar day starts and ends.</p><h2>Customize the dashboard</h2><p>Select <strong>Edit dashboard</strong> to add or remove cards, resize them, move them between sections, or reset the page to its default layout. Your saved layout is personal to your staff account.</p><h2>Open a detailed report</h2><p>Cards that support more detail include a report link. A report keeps the selected date and location filters. Select <strong>Export CSV</strong> to download up to 10,000 rows for spreadsheet analysis.</p><h2>Understand sales totals</h2><p>Total sales includes recognized online, Cash on Delivery, store-credit, and completed Point of Sale orders. Completed refunds are subtracted on their settlement date. Pending and cancelled payment attempts are excluded.</p><h2>Google Search data</h2><p>Search cards show clicks, impressions, click-through rate, average position, search terms, and landing pages. Google normally reports this data with a delay and can hide rare searches for privacy.</p><h2>Advanced analytics</h2><p>Advanced analytics, including merchant GA4 and Meta Pixel connections and storefront conversion reporting, is included in the <strong>Pro plan</strong>. Tracking integrations load only after the applicable visitor consent.</p>',
       'published',
       'Understand your StoreMink Analytics dashboard',
       'Use StoreMink Analytics, customize dashboard cards, read sales and Google Search reports, and export CSV data.',
       1, now()
FROM public.help_categories AS category
WHERE category.slug = 'analytics'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position)
SELECT category.id,
       article.slug,
       article.title,
       article.excerpt,
       article.body,
       'draft',
       article.title,
       article.excerpt,
       article.position
FROM public.help_categories AS category
CROSS JOIN (VALUES
  ('connect-google-analytics-4',
   'Connect Google Analytics 4',
   'Create a GA4 web stream, find its Measurement ID, and connect it to a Pro storefront.',
   '<p><strong>Pro feature:</strong> This guide is a draft for the upcoming StoreMink GA4 connection.</p><h2>Before you begin</h2><p>You need a Google Analytics account with permission to create or edit a property. Your StoreMink subdomain can be used as the website URL.</p><h2>Find your Measurement ID</h2><ol><li>Open Google Analytics and select the correct property.</li><li>Go to Admin, then Data streams.</li><li>Create or open a Web stream for your storefront URL.</li><li>Copy the Measurement ID beginning with <strong>G-</strong>.</li></ol><h2>Connect StoreMink</h2><p>In StoreMink, open the advanced analytics settings, enter the Measurement ID, and save. StoreMink validates the ID before enabling it.</p><h2>Consent</h2><p>The Google tag is not loaded until the visitor gives the applicable analytics consent. A visitor who declines can continue shopping normally.</p>',
   2),
  ('connect-meta-pixel',
   'Connect a Meta Pixel',
   'Create a Meta web dataset, find its Pixel ID, and connect it to a Pro storefront.',
   '<p><strong>Pro feature:</strong> This guide is a draft for the upcoming StoreMink Meta Pixel connection.</p><h2>Before you begin</h2><p>You need access to Meta Events Manager for your business. Basic browser tracking works on a StoreMink subdomain; features that require independent domain verification may require your own custom domain.</p><h2>Find your Pixel ID</h2><ol><li>Open Meta Events Manager.</li><li>Select Connect data, then Web.</li><li>Create or open your web dataset.</li><li>Copy its numeric Pixel ID.</li></ol><h2>Connect StoreMink</h2><p>In StoreMink, open the advanced analytics settings, enter the Pixel ID, and save. StoreMink validates the ID before enabling it.</p><h2>Consent</h2><p>The Meta Pixel is not loaded until the visitor gives the applicable marketing consent. A visitor who declines can continue shopping normally.</p>',
   3)
) AS article(slug, title, excerpt, body, position)
WHERE category.slug = 'analytics'
ON CONFLICT (slug) DO NOTHING;
