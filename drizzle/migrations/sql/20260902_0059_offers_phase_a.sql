-- Offers Phase A (docs/offers-plan.md §15) — one engine for every discount.
--
-- Coupons become one DELIVERY METHOD of an offer rather than a separate
-- system, so this creates the offer spine and migrates existing coupon rows
-- into it. `coupons` is left in place: `orders.applied_coupon_code` is
-- historical data on issued invoices and readers are repointed rather than the
-- table dropped, the way `homepage_sections` and `store_subscriptions` were.
--
-- ★ THE PER-LINE ALLOCATION IS THE POINT. `order_items.offer_discount` records
-- which line an offer actually discounted. Storing a scoped reward only in
-- `orders.discount` mis-files GST (computeTax spreads it proportionally) and
-- over-refunds returns (a Buy-1-Get-1 free line comes back at full price).

-- ---------------------------------------------------------------------------
-- 1. The offer
-- ---------------------------------------------------------------------------

CREATE TABLE public.offers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'disabled',
  delivery            TEXT NOT NULL DEFAULT 'automatic',
  -- Uppercased on write; NULL for an automatic offer.
  code                TEXT,
  priority            INTEGER NOT NULL DEFAULT 0,
  trigger_type        TEXT NOT NULL DEFAULT 'always',
  trigger_config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  reward_type         TEXT NOT NULL,
  reward_config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Empty array = every channel / every location.
  channels            TEXT[] NOT NULL DEFAULT '{}',
  valid_from          TIMESTAMPTZ,
  valid_until         TIMESTAMPTZ,
  -- Limits (plan §11). NULL = uncapped.
  max_redemptions     INTEGER,
  max_per_customer    INTEGER,
  budget_paise        BIGINT,
  -- Counters, moved only by the atomic reservation functions below.
  redemption_count    INTEGER NOT NULL DEFAULT 0,
  spent_paise         BIGINT NOT NULL DEFAULT 0,
  created_by          TEXT,
  updated_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT offers_id_store_key UNIQUE (id, store_id),
  CONSTRAINT offers_store_code_key UNIQUE (store_id, code),
  CONSTRAINT offers_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT offers_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT offers_delivery_check
    CHECK (delivery IN ('automatic', 'code', 'link')),
  -- ★ A code offer without a code can never be redeemed by anybody. Refusing
  -- it here means the engine's `code_required` skip is a defence in depth
  -- rather than the only thing standing between a merchant and a dead offer.
  -- ★ THE BOUND IS 200, NOT A TIDY 3-40. `coupons.code` is unbounded `text`
  -- with no length validation anywhere in the app — only "not empty" — so a
  -- one-character code is legal and may exist in production. A constraint
  -- narrower than what the system already accepts would silently refuse to
  -- migrate a live, working code, which is invariant 1. A minimum length is a
  -- product decision and belongs in the server action, where it can change
  -- without a migration; the column enforces only what is structurally
  -- required: present, normalised, and bounded.
  CONSTRAINT offers_code_present_check CHECK (
    (delivery = 'automatic' AND code IS NULL)
    OR (delivery IN ('code', 'link') AND code IS NOT NULL
        AND code = upper(code) AND code !~ '\s'
        AND char_length(code) BETWEEN 1 AND 200)
  ),
  CONSTRAINT offers_trigger_type_check
    CHECK (trigger_type IN ('always', 'min_subtotal')),
  CONSTRAINT offers_reward_type_check
    CHECK (reward_type IN ('percent_off', 'amount_off', 'percent_off_items')),
  CONSTRAINT offers_config_shape_check CHECK (
    jsonb_typeof(trigger_config) = 'object'
    AND jsonb_typeof(reward_config) = 'object'
  ),
  CONSTRAINT offers_channels_check CHECK (
    channels <@ ARRAY['storefront', 'pos']::TEXT[]
  ),
  CONSTRAINT offers_window_check
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until),
  CONSTRAINT offers_limits_check CHECK (
    (max_redemptions IS NULL OR max_redemptions > 0)
    AND (max_per_customer IS NULL OR max_per_customer > 0)
    AND (budget_paise IS NULL OR budget_paise > 0)
    AND redemption_count >= 0
    AND spent_paise >= 0
  ),
  CONSTRAINT offers_priority_check CHECK (priority BETWEEN -1000 AND 1000)
);

-- The engine's candidate query: live offers for one store.
CREATE INDEX offers_live_idx
  ON public.offers (store_id, status, priority DESC, created_at)
  WHERE status = 'active';

CREATE INDEX offers_code_idx ON public.offers (store_id, code)
  WHERE code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Scoping — join tables, not arrays, so they are indexable and FK-checked
-- ---------------------------------------------------------------------------

CREATE TABLE public.offer_products (
  offer_id   UUID NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  store_id   UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES public.product_variants(id) ON DELETE CASCADE,
  category_id UUID REFERENCES public.categories(id) ON DELETE CASCADE,
  CONSTRAINT offer_products_one_target_check CHECK (
    (product_id IS NOT NULL)::int
    + (variant_id IS NOT NULL)::int
    + (category_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT offer_products_offer_store_fkey
    FOREIGN KEY (offer_id, store_id) REFERENCES public.offers(id, store_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX offer_products_product_key
  ON public.offer_products (offer_id, product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX offer_products_variant_key
  ON public.offer_products (offer_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX offer_products_category_key
  ON public.offer_products (offer_id, category_id) WHERE category_id IS NOT NULL;

CREATE TABLE public.offer_locations (
  offer_id    UUID NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  store_id    UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.store_locations(id) ON DELETE CASCADE,
  PRIMARY KEY (offer_id, location_id),
  CONSTRAINT offer_locations_offer_store_fkey
    FOREIGN KEY (offer_id, store_id) REFERENCES public.offers(id, store_id)
    ON DELETE CASCADE
);

CREATE TABLE public.offer_user_groups (
  offer_id UUID NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES public.user_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (offer_id, group_id),
  CONSTRAINT offer_user_groups_offer_store_fkey
    FOREIGN KEY (offer_id, store_id) REFERENCES public.offers(id, store_id)
    ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 3. Redemptions — what makes "once per customer" answerable at all
-- ---------------------------------------------------------------------------
--
-- ★ A TABLE, NOT A COUNTER. `coupons.used_count` is a single conditional
-- UPDATE, which is exactly right for a global cap and structurally incapable of
-- a per-person one: it knows how many times a code was used, never by whom.

CREATE TABLE public.offer_redemptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id     UUID NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  store_id     UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  order_id     UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  customer_id  TEXT,
  amount_paise BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT offer_redemptions_amount_check CHECK (amount_paise >= 0),
  CONSTRAINT offer_redemptions_offer_store_fkey
    FOREIGN KEY (offer_id, store_id) REFERENCES public.offers(id, store_id)
    ON DELETE CASCADE
);

-- ★ ONE REDEMPTION PER (OFFER, ORDER). The reservation runs before the order
-- exists and is back-filled with the order id, so a retried checkout cannot
-- record the same offer against the same order twice.
CREATE UNIQUE INDEX offer_redemptions_order_key
  ON public.offer_redemptions (offer_id, order_id) WHERE order_id IS NOT NULL;

CREATE INDEX offer_redemptions_customer_idx
  ON public.offer_redemptions (offer_id, customer_id) WHERE customer_id IS NOT NULL;

CREATE INDEX offer_redemptions_store_idx
  ON public.offer_redemptions (store_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. What each order line actually received
-- ---------------------------------------------------------------------------

ALTER TABLE public.order_items
  ADD COLUMN offer_discount NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_offer_discount_check CHECK (offer_discount >= 0);

CREATE TABLE public.order_item_offers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id UUID NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  order_id      UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  store_id      UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- ★ SET NULL, NOT CASCADE. Deleting an offer must never delete the record of
  -- what an issued invoice charged.
  offer_id      UUID REFERENCES public.offers(id) ON DELETE SET NULL,
  -- ★ THE NAME IS SNAPSHOTTED. A rename next month must not change what last
  -- month's receipt says, and a deleted offer must still be explainable.
  offer_name    TEXT NOT NULL,
  reward_type   TEXT NOT NULL,
  amount        NUMERIC(12, 2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_item_offers_amount_check CHECK (amount >= 0),
  CONSTRAINT order_item_offers_item_key UNIQUE (order_item_id, offer_id)
);

CREATE INDEX order_item_offers_order_idx ON public.order_item_offers (order_id);
CREATE INDEX order_item_offers_offer_idx
  ON public.order_item_offers (offer_id, created_at DESC) WHERE offer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Atomic reservation — the three caps, claimed in ONE statement
-- ---------------------------------------------------------------------------
--
-- The `increment_coupon_usage` pattern: every guard lives in the WHERE clause,
-- so a concurrent caller re-evaluates it against the freshly committed value.
-- A read-then-write would let two simultaneous checkouts both pass the last
-- redemption, or both spend the last of the budget.

CREATE OR REPLACE FUNCTION public.reserve_offer_use(
  p_offer_id UUID,
  p_store_id UUID,
  p_customer_id TEXT,
  p_amount_paise BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reserved BOOLEAN;
BEGIN
  IF p_amount_paise IS NULL OR p_amount_paise < 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE public.offers
     SET redemption_count = redemption_count + 1,
         spent_paise = spent_paise + p_amount_paise
   WHERE id = p_offer_id
     AND store_id = p_store_id
     AND status = 'active'
     AND (max_redemptions IS NULL OR redemption_count < max_redemptions)
     AND (budget_paise IS NULL OR spent_paise + p_amount_paise <= budget_paise)
     -- ★ The per-customer cap is checked INSIDE the same statement, against
     -- the redemption ledger. Doing it as a separate SELECT reintroduces the
     -- read-then-write window this function exists to close.
     AND (
       max_per_customer IS NULL
       OR p_customer_id IS NULL
       OR (
         SELECT count(*)
           FROM public.offer_redemptions r
          WHERE r.offer_id = public.offers.id
            AND r.customer_id = p_customer_id
       ) < max_per_customer
     )
  RETURNING TRUE INTO v_reserved;

  RETURN COALESCE(v_reserved, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_offer_use(
  p_offer_id UUID,
  p_store_id UUID,
  p_amount_paise BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.offers
     SET redemption_count = GREATEST(redemption_count - 1, 0),
         spent_paise = GREATEST(spent_paise - COALESCE(p_amount_paise, 0), 0)
   WHERE id = p_offer_id
     AND store_id = p_store_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_offer_use(UUID, UUID, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_offer_use(UUID, UUID, BIGINT) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
--
-- `offers` follows the `coupons` shape: anon may read ACTIVE offers, because
-- the storefront shows badges and the near-miss nudge. Everything that is not
-- safe to publish (budget, spend, redemption counts, per-customer caps) is
-- withheld by a column grant rather than by a policy — the `store_pages` draft
-- seal, because a policy cannot hide a column.

ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offer_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offer_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offer_user_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offer_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read active offers" ON public.offers
  FOR SELECT TO public
  USING (status = 'active' OR (SELECT public.is_store_admin(offers.store_id)));

CREATE POLICY "Admins manage offers" ON public.offers
  FOR ALL TO authenticated
  USING ((SELECT public.is_store_admin(offers.store_id)))
  WITH CHECK ((SELECT public.is_store_admin(offers.store_id)));

CREATE POLICY "Read offer products" ON public.offer_products
  FOR SELECT TO public USING (TRUE);
CREATE POLICY "Admins manage offer products" ON public.offer_products
  FOR ALL TO authenticated
  USING ((SELECT public.is_store_admin(offer_products.store_id)))
  WITH CHECK ((SELECT public.is_store_admin(offer_products.store_id)));

CREATE POLICY "Read offer locations" ON public.offer_locations
  FOR SELECT TO public USING (TRUE);
CREATE POLICY "Admins manage offer locations" ON public.offer_locations
  FOR ALL TO authenticated
  USING ((SELECT public.is_store_admin(offer_locations.store_id)))
  WITH CHECK ((SELECT public.is_store_admin(offer_locations.store_id)));

-- ★ Group membership is NOT anon-readable. Which segments an offer targets is
-- merchant information, and the engine resolves groups server-side anyway.
CREATE POLICY "Admins manage offer groups" ON public.offer_user_groups
  FOR ALL TO authenticated
  USING ((SELECT public.is_store_admin(offer_user_groups.store_id)))
  WITH CHECK ((SELECT public.is_store_admin(offer_user_groups.store_id)));

CREATE POLICY "Admins read offer redemptions" ON public.offer_redemptions
  FOR SELECT TO authenticated
  USING ((SELECT public.is_store_admin(offer_redemptions.store_id)));

CREATE POLICY "Admins read order item offers" ON public.order_item_offers
  FOR SELECT TO authenticated
  USING ((SELECT public.is_store_admin(order_item_offers.store_id)));

-- Redemptions and per-line offer records are written by the service role only:
-- a client that could forge either could claim a discount it never earned.
REVOKE ALL ON TABLE public.offer_redemptions FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.order_item_offers FROM PUBLIC, anon;

-- ★ THE SEAL: anon reads only the columns the storefront must render. Budget,
-- spend and redemption counts leak a store's promotional economics, and
-- `spent_paise` in particular would let anyone watch a budget drain in real
-- time and time their order.
REVOKE SELECT ON public.offers FROM anon, authenticated;
GRANT SELECT (
  id, store_id, name, description, status, delivery, code, priority,
  trigger_type, trigger_config, reward_type, reward_config, channels,
  valid_from, valid_until, created_at, updated_at
) ON public.offers TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Migrate coupons into offers
-- ---------------------------------------------------------------------------
--
-- Every existing coupon becomes a `code`-delivery offer with the identical
-- rule. ★ `max_uses = 0` means unlimited in the coupon schema and NULL here,
-- so a zero must not migrate as a cap of zero — that would silently disable
-- every unlimited coupon on the platform.

INSERT INTO public.offers (
  id, store_id, name, description, status, delivery, code, priority,
  trigger_type, trigger_config, reward_type, reward_config, channels,
  valid_from, valid_until, max_redemptions, redemption_count,
  created_by, updated_by, created_at, updated_at
)
SELECT
  c.id,
  c.store_id,
  c.code,
  c.description,
  CASE WHEN c.status = 'active' THEN 'active' ELSE 'disabled' END,
  'code',
  c.code,
  0,
  CASE WHEN COALESCE(c.min_order_amount, 0) > 0 THEN 'min_subtotal' ELSE 'always' END,
  CASE
    WHEN COALESCE(c.min_order_amount, 0) > 0
      THEN jsonb_build_object('minSubtotal', c.min_order_amount)
    ELSE '{}'::jsonb
  END,
  CASE WHEN c.discount_type = 'fixed' THEN 'amount_off' ELSE 'percent_off' END,
  CASE
    WHEN c.discount_type = 'fixed'
      THEN jsonb_build_object('amount', c.discount_value)
    ELSE jsonb_build_object('percent', c.discount_value)
  END,
  -- Coupons have only ever applied on the storefront; the till could not take
  -- one. Migrating them as "every channel" would switch every existing coupon
  -- on at every till, which is invariant 1.
  ARRAY['storefront']::TEXT[],
  c.valid_from,
  c.valid_until,
  NULLIF(c.max_uses, 0),
  COALESCE(c.used_count, 0),
  c.created_by,
  c.updated_by,
  c.created_at,
  c.updated_at
FROM public.coupons c
-- ★ ONLY CODES ALREADY IN NORMAL FORM, and that is exactly the set of
-- REDEEMABLE coupons rather than an arbitrary filter. `validateCoupon`
-- uppercases and strips spaces from what the shopper types, then matches the
-- stored code EXACTLY — so a coupon stored as `save10` or `SAVE 10` cannot be
-- redeemed by anybody today and has not been redeemable since it was created.
-- Migrating those would be the only way this INSERT could fail: two such rows
-- collapse to one code under `offers_store_code_key`, and `coupons` guarantees
-- uniqueness on the RAW code, not the normalised one. Leaving them behind
-- loses nothing a customer could use and cannot error.
-- ★ THE FILTER MIRRORS `normalizeCode` EXACTLY: uppercase with ALL whitespace
-- removed, not merely trimmed. `SAVE 10` survives a `btrim` unchanged and is
-- still dead, because the shopper's input normalises to `SAVE10` and the match
-- is exact — so migrating it would create an offer carrying a code nobody can
-- ever redeem, sitting in the merchant's list looking live.
WHERE c.code IS NOT NULL
  AND c.code = regexp_replace(upper(c.code), '\s', '', 'g')
  AND char_length(c.code) BETWEEN 1 AND 200
ON CONFLICT DO NOTHING;

-- Group restrictions carry across with the same ids. Joined to `offers` so a
-- coupon skipped above (an out-of-range code) cannot orphan a group row.
INSERT INTO public.offer_user_groups (offer_id, store_id, group_id)
SELECT cug.coupon_id, cug.store_id, cug.group_id
  FROM public.coupon_user_groups cug
  JOIN public.offers o
    ON o.id = cug.coupon_id AND o.store_id = cug.store_id
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Help Centre
-- ---------------------------------------------------------------------------

WITH marketing_category AS (
  SELECT id FROM public.help_categories WHERE slug = 'marketing'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT marketing_category.id,
       guide.slug,
       guide.title,
       guide.excerpt,
       guide.body,
       'published',
       guide.seo_title,
       guide.seo_description,
       guide.position,
       now()
FROM marketing_category
CROSS JOIN (VALUES
  (
    'create-and-manage-offers',
    'Create and manage offers',
    'Set up discount codes and automatic offers, control how deep they can go, and understand which offer a customer gets when more than one could apply.',
    $article$<p>An offer is one discount rule. You choose what has to be true for it to apply, what the customer gets, and where it runs — your online store, your point of sale, or both. StoreMink re-checks every rule on the server at checkout, so changing the page cannot bypass a limit you set.</p>
<h2>A discount code is a delivery method, not a separate feature</h2>
<p>Every offer chooses how it reaches a customer: <strong>automatically</strong>, on a <strong>code</strong> the shopper enters, or from a <strong>shareable link</strong>. The rule itself is the same either way, so you can turn a code into an automatic offer without rebuilding it.</p>
<h2>Best offer wins</h2>
<p>When more than one of your offers could apply to the same order, StoreMink applies the combination that saves the customer the most. Offers do not stack: a basket line carries one offer, and an order carries one order-level offer.</p>
<p>This means the system chooses which offer applies, not you. If two offers save exactly the same amount, the one with the higher priority wins. Priority only decides ties — it never overrides a genuinely better saving.</p>
<h2>Keeping an offer safe</h2>
<p>Because the system actively looks for the most generous offer that applies, two limits are worth setting on every offer you create.</p>
<ul>
<li><strong>A total budget.</strong> The offer stops once it has given away the amount you set. This is what stops a mistyped offer running all weekend.</li>
<li><strong>A usage limit.</strong> Cap redemptions in total, per customer, or both.</li>
</ul>
<p>There is also a store-wide ceiling on how deep any single order can be discounted, in <strong>Settings</strong>. No combination of offers can take an order past it.</p>
<h2>Offers and sale prices</h2>
<p>Some products already carry a sale price. You choose how offers treat those in <strong>Settings</strong>.</p>
<ul>
<li><strong>Best price wins</strong> (the default) — the customer pays whichever is lower, the sale price or the offer price. The two are never combined.</li>
<li><strong>Skip sale items</strong> — offers do not apply to anything already on a sale price.</li>
<li><strong>Stack on sale prices</strong> — the offer applies on top of the sale price. Choose this deliberately: it is what an "extra 20% off sale" promotion needs, and it discounts twice.</li>
</ul>
<h2>What shoppers see</h2>
<p>When a cart is close to qualifying for an offer, it shows how much more the shopper needs to add. This never happens for an offer that needs a code, or one restricted to a customer group — otherwise a code you sent to selected customers would be shown to everyone.</p>
<h2>Your existing coupons</h2>
<p>Every coupon you already had is now an offer, with the same code, the same discount, the same dates and the same usage limit. Nothing changed for your customers, and any code you have advertised keeps working. Migrated coupons apply on your online store only, because that is where they worked before; edit an offer if you want it available at your point of sale too.</p>
<h2>What offers do not do yet</h2>
<p>An offer cannot be applied to an order that has already been placed. If goods are damaged when a customer collects an order, use a partial refund or store credit — both keep a proper record against the invoice that was already issued.</p>
<p>Offers on specific products or categories, buy-one-get-one, spend-more-save-more tiers, free delivery and gift-with-purchase are not available yet. Today an offer applies a percentage or a rupee amount to the whole order.</p>$article$,
    'Create and manage offers | StoreMink Help',
    'How to create discount codes and automatic offers in StoreMink, set budget and usage limits, and understand which offer applies when several could.',
    3
  )
) AS guide(slug, title, excerpt, body, seo_title, seo_description, position)
ON CONFLICT (slug) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  body = EXCLUDED.body,
  status = EXCLUDED.status,
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  position = EXCLUDED.position,
  published_at = COALESCE(existing.published_at, EXCLUDED.published_at),
  updated_at = now();
