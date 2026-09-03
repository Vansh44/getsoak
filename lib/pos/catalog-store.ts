// IndexedDB persistence for the POS catalog cache.
//
// Deliberately thin and total: EVERY function degrades to a no-op (or null)
// when IndexedDB is unavailable — private-mode Safari, a locked-down kiosk
// browser, a quota-exceeded device. The register must fall back to the server
// and keep selling, never break because a cache couldn't be opened.
//
// The pure matching logic lives in catalog-index.ts; this file only stores and
// retrieves. Phase 9's offline outbox is intended to reuse this database.

import type { CatalogItem } from "./catalog-index";

const DB_NAME = "storemink-pos";
const DB_VERSION = 1;
const STORE = "catalog";

/**
 * Bump whenever CatalogItem gains a field the register RELIES on. Cached
 * entries are keyed by it, so an older shape simply isn't found and the
 * register re-syncs instead of serving items missing the new field.
 *
 * v4 added `categoryId`, which offer scoping needs: without it the sell screen
 * would quote a different total from the one `placePosSale` charges as soon as
 * a category-scoped offer exists (docs/offers-plan.md).
 * v2 added `taxClassId` — without it a cached line resolves to the store's
 * default tax rate, which would quote the customer a total the server then
 * charges differently. A cache may serve a stale PRICE for a few minutes
 * (harmless: the server re-prices), but it must not serve a stale SHAPE.
 */
// ★ BUMPED FOR THE DELTA CACHE (Step 19): the record now carries a watermark,
// and a v2 entry has none. Serving one would make the first sync a delta with
// no `since`, which the server reads as a FULL pull — correct, but only by
// accident. A version bump re-syncs once and removes the accident.
const SCHEMA_VERSION = "v4";

/** One cached catalog per register: a location's stock is its own truth, and
 *  an operator can legitimately move between stores on a shared browser. */
export const catalogKey = (storeId: string, locationId: string): string =>
  `${SCHEMA_VERSION}:${storeId}:${locationId}`;

export interface CachedCatalog {
  /** Server-issued instant to pass as `since` on the next sync. Null means
   *  "never synced incrementally" — do a full pull. */
  watermark?: string | null;
  key: string;
  items: CatalogItem[];
  /** Epoch ms of the sync that produced `items` — drives staleness display. */
  syncedAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let idb: IDBFactory | undefined;
    try {
      idb = typeof indexedDB !== "undefined" ? indexedDB : undefined;
    } catch {
      // Accessing indexedDB THROWS in some privacy modes rather than being
      // undefined, so the feature check itself has to be guarded.
      idb = undefined;
    }
    if (!idb) return resolve(null);

    let req: IDBOpenDBRequest;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // A blocked upgrade would otherwise hang the register's first paint behind
    // a promise that never settles.
    req.onblocked = () => resolve(null);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return new Promise((resolve) => {
    let req: IDBRequest<T>;
    try {
      req = run(db.transaction(STORE, mode).objectStore(STORE));
    } catch {
      return resolve(null);
    }
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function readCatalog(key: string): Promise<CachedCatalog | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const row = await tx<CachedCatalog>(db, "readonly", (s) => s.get(key));
    return row && Array.isArray(row.items) ? row : null;
  } finally {
    db.close();
  }
}

export async function writeCatalog(
  key: string,
  items: CatalogItem[],
  syncedAt = Date.now(),
  /** Server-issued; omitted on a full pull that produced none. */
  watermark: string | null = null,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    // Quota failures resolve null rather than throwing — a cashier must never
    // see a sale fail because the cache was full.
    await tx(db, "readwrite", (s) =>
      s.put({ key, items, syncedAt, watermark }),
    );
  } finally {
    db.close();
  }
}

export async function clearCatalog(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await tx(db, "readwrite", (s) => s.delete(key));
  } finally {
    db.close();
  }
}
