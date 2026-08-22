-- Phase 9: consented, first-party storefront conversion analytics.
-- Raw rows are deliberately short-lived; storefront_daily is the durable,
-- non-identifying reporting surface. visitor_key rotates each store-local day.

CREATE TABLE public.storefront_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL,
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  event_date  date NOT NULL,
  visitor_key text NOT NULL,
  event_type  text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  path        text,
  product_id  uuid,
  order_id    uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storefront_events_store_event_key UNIQUE (store_id, event_id),
  CONSTRAINT storefront_events_type_check CHECK (
    event_type IN ('page_view', 'product_view', 'add_to_cart', 'checkout_start', 'purchase')
  ),
  CONSTRAINT storefront_events_visitor_key_check CHECK (length(visitor_key) BETWEEN 16 AND 64),
  CONSTRAINT storefront_events_path_check CHECK (path IS NULL OR (left(path, 1) = '/' AND length(path) <= 512))
);

CREATE UNIQUE INDEX storefront_events_purchase_order_key
  ON public.storefront_events (store_id, order_id)
  WHERE event_type = 'purchase' AND order_id IS NOT NULL;
CREATE INDEX storefront_events_store_date_idx
  ON public.storefront_events (store_id, event_date, visitor_key, occurred_at);
CREATE INDEX storefront_events_created_idx ON public.storefront_events (created_at);

CREATE TABLE public.storefront_order_attribution (
  order_id     uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  store_id     uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  event_date   date NOT NULL,
  visitor_key  text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  converted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storefront_order_attribution_visitor_key_check CHECK (length(visitor_key) BETWEEN 16 AND 64)
);
CREATE INDEX storefront_order_attribution_created_idx
  ON public.storefront_order_attribution (created_at);

CREATE TABLE public.storefront_daily (
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  date              date NOT NULL,
  visitors          integer NOT NULL DEFAULT 0,
  sessions          integer NOT NULL DEFAULT 0,
  page_views        integer NOT NULL DEFAULT 0,
  product_sessions  integer NOT NULL DEFAULT 0,
  cart_sessions     integer NOT NULL DEFAULT 0,
  checkout_sessions integer NOT NULL DEFAULT 0,
  converted_sessions integer NOT NULL DEFAULT 0,
  purchases         integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, date),
  CONSTRAINT storefront_daily_nonnegative CHECK (
    visitors >= 0 AND sessions >= 0 AND page_views >= 0 AND
    product_sessions >= 0 AND cart_sessions >= 0 AND checkout_sessions >= 0 AND
    converted_sessions >= 0 AND purchases >= 0
  )
);

ALTER TABLE public.storefront_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_order_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.storefront_events, public.storefront_order_attribution, public.storefront_daily FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_events, public.storefront_order_attribution, public.storefront_daily TO app_service;

UPDATE public.platform_analytics_settings
SET storefront_conversion = TRUE, updated_at = now()
WHERE id = TRUE;

INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT category.id,
       'understand-storefront-conversion-analytics',
       'Understand storefront conversion analytics',
       'Learn how StoreMink measures consented visitors, sessions, page views, funnel steps, and purchases without a persistent device ID.',
       '<p><strong>Pro feature:</strong> Storefront conversion analytics is available when StoreMink enables it for your store plan.</p><h2>What StoreMink measures</h2><p>After a visitor allows analytics in the storefront privacy choices, StoreMink records page views and the ordered shopping steps: product viewed, item added to cart, checkout started, and purchase completed.</p><h2>Visitors and sessions</h2><p>A visitor is counted with a one-way pseudonymous key made from request information. The key changes every day in your business time zone and is not stored in the browser. A new session starts after 30 minutes without activity.</p><h2>Conversion funnel</h2><p>A session reaches a funnel step only when the earlier steps happened in order. Conversion rate is converted sessions divided by all consented sessions. Online orders paid later keep their original anonymous attribution so a successful payment is counted once.</p><h2>Consent and privacy</h2><p>StoreMink does not collect these events until the visitor opts in to analytics. Raw event rows and temporary order attribution are retained for 14 days; daily counts remain for reporting. StoreMink filters common automated traffic and rate-limits the collection endpoint.</p><h2>Why totals can differ</h2><p>Visitors who reject analytics are not counted. Browser blocking, automated-traffic filtering, the 30-minute session rule, and delayed daily aggregation can also make these figures differ from orders or another analytics tool.</p><h2>Before going live</h2><p>Your privacy policy and consent wording must describe the analytics you use. Privacy and cookie rules vary by country, so obtain appropriate legal advice for the markets where you sell.</p>',
       'published',
       'Understand StoreMink storefront conversion analytics',
       'Understand consented visitors, sessions, conversion funnel steps, retention, privacy, and purchase attribution in StoreMink Analytics.',
       11, now()
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
