import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";

/**
 * Rebuild every raw bucket still inside the 14-day correction window.
 * Rebuilding (rather than incrementing) makes retries and late purchase events
 * deterministic. The primary-key upsert is the cross-instance lock.
 */
export async function runStorefrontAnalyticsRollup(): Promise<number> {
  const result = await withService((db) =>
    db.execute(sql`
      WITH ordered AS (
        SELECT e.*,
               lag(e.occurred_at) OVER (
                 PARTITION BY e.store_id, e.event_date, e.visitor_key
                 ORDER BY e.occurred_at, e.id
               ) AS previous_at
          FROM storefront_events e
         WHERE e.created_at >= now() - interval '14 days'
      ), marked AS (
        SELECT ordered.*,
               CASE WHEN previous_at IS NULL
                          OR occurred_at - previous_at > interval '30 minutes'
                    THEN 1 ELSE 0 END AS starts_session
          FROM ordered
      ), numbered AS (
        SELECT marked.*,
               sum(starts_session) OVER (
                 PARTITION BY store_id, event_date, visitor_key
                 ORDER BY occurred_at, id
               ) AS session_no
          FROM marked
      ), session_steps AS (
        SELECT store_id, event_date, visitor_key, session_no,
               count(*) FILTER (WHERE event_type = 'page_view')::int AS page_views,
               min(occurred_at) FILTER (WHERE event_type = 'product_view') AS product_at,
               count(*) FILTER (WHERE event_type = 'purchase')::int AS purchases
          FROM numbered
         GROUP BY store_id, event_date, visitor_key, session_no
      ), cart_steps AS (
        SELECT s.*,
               min(e.occurred_at) FILTER (
                 WHERE e.event_type = 'add_to_cart' AND e.occurred_at > s.product_at
               ) AS cart_at
          FROM session_steps s
          LEFT JOIN numbered e USING (store_id, event_date, visitor_key, session_no)
         GROUP BY s.store_id, s.event_date, s.visitor_key, s.session_no,
                  s.page_views, s.product_at, s.purchases
      ), checkout_steps AS (
        SELECT s.*,
               min(e.occurred_at) FILTER (
                 WHERE e.event_type = 'checkout_start' AND e.occurred_at > s.cart_at
               ) AS checkout_at
          FROM cart_steps s
          LEFT JOIN numbered e USING (store_id, event_date, visitor_key, session_no)
         GROUP BY s.store_id, s.event_date, s.visitor_key, s.session_no,
                  s.page_views, s.product_at, s.purchases, s.cart_at
      ), purchase_steps AS (
        SELECT s.*,
               min(e.occurred_at) FILTER (
                 WHERE e.event_type = 'purchase' AND e.occurred_at >= s.checkout_at
               ) AS purchase_at
          FROM checkout_steps s
          LEFT JOIN numbered e USING (store_id, event_date, visitor_key, session_no)
         GROUP BY s.store_id, s.event_date, s.visitor_key, s.session_no,
                  s.page_views, s.product_at, s.purchases, s.cart_at, s.checkout_at
      ), bucket AS (
        SELECT store_id, event_date,
               count(DISTINCT visitor_key)::int AS visitors,
               count(*)::int AS sessions,
               coalesce(sum(page_views), 0)::int AS page_views,
               count(*) FILTER (WHERE product_at IS NOT NULL)::int AS product_sessions,
               count(*) FILTER (WHERE cart_at IS NOT NULL)::int AS cart_sessions,
               count(*) FILTER (WHERE checkout_at IS NOT NULL)::int AS checkout_sessions,
               count(*) FILTER (WHERE purchase_at IS NOT NULL)::int AS converted_sessions,
               coalesce(sum(purchases), 0)::int AS purchases
          FROM purchase_steps
         GROUP BY store_id, event_date
      )
      INSERT INTO storefront_daily
        (store_id, date, visitors, sessions, page_views, product_sessions,
         cart_sessions, checkout_sessions, converted_sessions, purchases, updated_at)
      SELECT store_id, event_date, visitors, sessions, page_views,
             product_sessions, cart_sessions, checkout_sessions,
             converted_sessions, purchases, now()
        FROM bucket
      ON CONFLICT (store_id, date) DO UPDATE SET
        visitors = EXCLUDED.visitors,
        sessions = EXCLUDED.sessions,
        page_views = EXCLUDED.page_views,
        product_sessions = EXCLUDED.product_sessions,
        cart_sessions = EXCLUDED.cart_sessions,
        checkout_sessions = EXCLUDED.checkout_sessions,
        converted_sessions = EXCLUDED.converted_sessions,
        purchases = EXCLUDED.purchases,
        updated_at = now()
      RETURNING store_id
    `),
  );
  return result.rowCount ?? 0;
}
