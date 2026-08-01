import "server-only";
import { eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { storeChrome, storeMenus } from "@/drizzle/schema";
import { withAnon, withService } from "@/lib/db/client";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { TAGS } from "@/lib/storefront/tags";
import { normalizeChrome, type StoreChrome } from "./types";

const REVALIDATE = 300;

/**
 * The PUBLISHED header + footer for a storefront render.
 *
 * Selects named columns, never `*`: `draft` is revoked from anon at the DB
 * layer (builder_01_store_chrome.sql) and a `*` here would fail — or worse,
 * succeed under a scope that can see it and leak unpublished chrome.
 *
 * A store with no row, or one that has never published, falls back to
 * DEFAULT_CHROME via normalizeChrome rather than rendering a bare page.
 */
export const getStoreChrome = unstable_cache(
  async (storeId: string): Promise<StoreChrome> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select({ published: storeChrome.published })
          .from(storeChrome)
          .where(eq(storeChrome.storeId, storeId))
          .limit(1),
      );
      if (rows[0]?.published) return normalizeChrome(rows[0].published);
      // Row missing, or present but never published.
      return await legacyMenusAsChrome(storeId);
    } catch {
      // The table itself may not exist yet — see legacyMenusAsChrome.
      return await legacyMenusAsChrome(storeId);
    }
  },
  ["store-chrome"],
  { tags: [TAGS.chrome], revalidate: REVALIDATE },
);

/**
 * Compatibility read: the old store_menus row, mapped into chrome.
 *
 * This exists so the deploy is ORDER-INDEPENDENT. Without it, shipping this
 * code before builder_01_store_chrome.sql runs would make every storefront
 * silently fall back to DEFAULT_CHROME — every merchant's navigation replaced
 * by the platform's stock links, with no error anywhere to explain it. A schema
 * migration and a deploy are two separate events and they will not be
 * simultaneous.
 *
 * Delete this together with the store_menus table, in the follow-up the
 * migration's closing note describes.
 */
async function legacyMenusAsChrome(storeId: string): Promise<StoreChrome> {
  try {
    const rows = await withAnon((db) =>
      db
        .select({
          header: storeMenus.header,
          footer_groups: storeMenus.footerGroups,
          footer_legal: storeMenus.footerLegal,
        })
        .from(storeMenus)
        .where(eq(storeMenus.storeId, storeId))
        .limit(1),
    );
    const m = rows[0];
    if (!m) return normalizeChrome(null);
    // Only the links carry over; every new toggle takes its default, which is
    // exactly what the old hardcoded footer rendered.
    return normalizeChrome({
      header: { links: m.header },
      footer: { groups: m.footer_groups, legal: m.footer_legal },
    });
  } catch {
    // Never let a chrome read break a storefront page — a store with the
    // default header beats a store with no header.
    return normalizeChrome(null);
  }
}

/**
 * The DRAFT chrome, for the builder's preview iframe.
 *
 * Mirrors lib/pages/preview.ts exactly: uncached (never poisons the published
 * cache), gated on the same `getManagerUserId("builder")` the builder's actions
 * use, and read with the SERVICE scope because `draft` is sealed from anon.
 * Returns null when unauthorized or absent so the caller falls back to the
 * published render — preview never leaks and never errors.
 */
export async function getDraftChromeForPreview(
  storeId: string,
): Promise<StoreChrome | null> {
  const userId = await getManagerUserId("builder");
  if (!userId) return null;

  try {
    const rows = await withService((db) =>
      db
        .select({ draft: storeChrome.draft })
        .from(storeChrome)
        .where(eq(storeChrome.storeId, storeId))
        .limit(1),
    );
    if (!rows.length) return null;
    return normalizeChrome(rows[0].draft);
  } catch {
    return null;
  }
}

/**
 * The draft as the BUILDER needs it — same service read and gate, but without
 * the storefront's default-filling, so an emptied list stays empty in the
 * editor instead of appearing to have silently repopulated.
 */
export async function getDraftChromeForEditor(
  storeId: string,
): Promise<StoreChrome | null> {
  const userId = await getManagerUserId("builder");
  if (!userId) return null;

  const rows = await withService((db) =>
    db
      .select({ draft: storeChrome.draft, published: storeChrome.published })
      .from(storeChrome)
      .where(eq(storeChrome.storeId, storeId))
      .limit(1),
  );
  // No row yet (a store created before this shipped, or one whose menus never
  // migrated): hand back the defaults so the editor opens on something real.
  if (!rows.length) return normalizeChrome(null);
  return normalizeChrome(rows[0].draft);
}
