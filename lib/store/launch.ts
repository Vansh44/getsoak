import "server-only";
import { eq, sql } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { STORE_TAG, type Store } from "@/lib/store/resolve";

/**
 * "Has this merchant actually put something of their own on this store yet?"
 *
 * A store is created in seconds and immediately holds a themed homepage, ~17
 * seeded content pages and a sample catalogue — all byte-identical to every
 * other store on that theme. Before this flag, `createStore` submitted that to
 * Google and IndexNow the moment it existed.
 *
 * Mass-submitting near-duplicate, placeholder stores is not merely wasted crawl
 * budget: it is the whole `*.storemink.com` domain repeatedly showing search
 * engines thin, templated content, and the cost is borne by every OTHER store
 * on the domain — including the ones that did the work. And the damage is not
 * undoable from code: `robots.txt` Disallow stops future crawling but does not
 * remove what is already indexed.
 *
 * So indexability is opt-in-by-doing: a store becomes crawlable the first time
 * its owner publishes something that is theirs.
 *
 * Stored on `stores.settings` (jsonb) rather than a column because it is a
 * per-store behaviour flag, exactly like `settings.features` — no migration,
 * and `settings` is already loaded on every host resolve. It is NOT a secret
 * (settings is anon-readable, CODEBASE.md §5.9); "this shop is open" is public
 * by definition.
 */
export function isStoreLaunched(
  store: Pick<Store, "settings"> | null | undefined,
): boolean {
  if (!store) return false;
  // Legacy stores predate the flag and are already indexed — treating them as
  // unlaunched would DEINDEX live shops, so absence means launched for anything
  // created before this shipped. `createStore` writes `launched: false`
  // explicitly, which is what makes new stores start closed.
  const v = store.settings?.launched;
  return v !== false;
}

/**
 * Mark a store launched. Idempotent, best-effort, and deliberately unable to
 * fail its caller — it runs after a publish that has already succeeded, and a
 * merchant must never see their page fail to publish because a search-engine
 * flag could not be written.
 */
export async function markStoreLaunched(storeId: string): Promise<void> {
  try {
    await withService((db) =>
      db
        .update(stores)
        .set({
          settings: sql`COALESCE(${stores.settings}, '{}'::jsonb) || '{"launched":true}'::jsonb`,
        })
        .where(eq(stores.id, storeId)),
    );
    // The host resolver caches `settings`; without this the store stays
    // noindex for up to the cache TTL after it goes live.
    const { revalidateTag } = await import("next/cache");
    revalidateTag(STORE_TAG, "max");
  } catch (err) {
    logError("markStoreLaunched failed", err, { storeId });
  }
}
