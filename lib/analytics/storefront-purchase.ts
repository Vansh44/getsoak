import "server-only";

import { headers } from "next/headers";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { storefrontEvents, storefrontOrderAttribution } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { storefrontVisitorIdentity } from "./storefront-identity";
import { logError } from "@/lib/observability/logger";

/** Keep an anonymous checkout bridge only when a consented checkout event from
 * this same daily key exists. Merely placing an order never creates consent. */
export async function recordStorefrontOrderAttribution(
  orderId: string,
  storeId: string,
): Promise<void> {
  try {
    const [store, requestHeaders] = await Promise.all([
      getCurrentStoreOrNull(),
      headers(),
    ]);
    if (!store || store.id !== storeId) return;
    const identity = storefrontVisitorIdentity(store, requestHeaders);
    if (!identity) return;
    const floor = new Date(Date.now() - 30 * 60_000).toISOString();
    const [checkout] = await withService((db) =>
      db
        .select({ occurredAt: storefrontEvents.occurredAt })
        .from(storefrontEvents)
        .where(
          and(
            eq(storefrontEvents.storeId, storeId),
            eq(storefrontEvents.eventDate, identity.eventDate),
            eq(storefrontEvents.visitorKey, identity.visitorKey),
            eq(storefrontEvents.eventType, "checkout_start"),
            gte(storefrontEvents.occurredAt, floor),
          ),
        )
        .orderBy(desc(storefrontEvents.occurredAt))
        .limit(1),
    );
    if (!checkout) return;
    await withService((db) =>
      db
        .insert(storefrontOrderAttribution)
        .values({
          orderId,
          storeId,
          eventDate: identity.eventDate,
          visitorKey: identity.visitorKey,
          occurredAt: checkout.occurredAt,
        })
        .onConflictDoNothing(),
    );
  } catch (error) {
    logError("storefront attribution failed", error, { orderId, storeId });
  }
}

/** Server-only purchase event. Browser callers can never declare a purchase;
 * the order state transition and DB uniqueness make delayed retries safe. */
export async function recordStorefrontPurchase(orderId: string): Promise<void> {
  try {
    await withService((db) =>
      db.execute(sql`
        INSERT INTO storefront_events
          (event_id, store_id, event_date, visitor_key, event_type,
           occurred_at, order_id)
        SELECT ${orderId}::uuid, a.store_id, a.event_date, a.visitor_key,
               'purchase', a.occurred_at + interval '1 millisecond',
               a.order_id
          FROM storefront_order_attribution a
         WHERE a.order_id = ${orderId}::uuid
        ON CONFLICT DO NOTHING
      `),
    );
    await withService((db) =>
      db
        .update(storefrontOrderAttribution)
        .set({ convertedAt: new Date().toISOString() })
        .where(eq(storefrontOrderAttribution.orderId, orderId)),
    );
  } catch (error) {
    logError("storefront purchase attribution failed", error, { orderId });
  }
}
