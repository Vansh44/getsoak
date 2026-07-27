"use client";

// The register's local catalog: hydrate from IndexedDB for an instant start,
// then sync the full catalog in the background. Search and scan then resolve
// in-memory with zero network — docs/pos-plan.md §10.
//
// Two rules keep this safe:
//   1. A local MISS falls through to the server (the caller's job). A product
//      created since the last sync must still be sellable the moment it exists.
//   2. Nothing here is authoritative. placePosSale re-reads prices and reserves
//      stock atomically at the location, so a stale entry is a display bug at
//      worst — never a wrong charge or an oversell.

import { useCallback, useEffect, useRef, useState } from "react";
import { getCatalogSnapshot } from "@/app/actions/pos-sale-actions";
import {
  EMPTY_INDEX,
  applyStockDeltas,
  buildIndex,
  scanLocal,
  searchLocal,
  type CatalogIndex,
  type CatalogItem,
} from "./catalog-index";
import { catalogKey, readCatalog, writeCatalog } from "./catalog-store";

/** Stock drifts all day on a register left open; re-sync often enough that the
 *  grid isn't lying, rarely enough that it's invisible on a shop's wifi. */
const RESYNC_MS = 5 * 60 * 1000;

/** Bounds memory and sync time on a pathological catalog. Past this the
 *  register still works — it just falls back to the server more often. */
const MAX_ITEMS = 20_000;
const MAX_PAGES = 200;

export interface CatalogState {
  /** True once an index exists (from cache OR a completed sync). */
  ready: boolean;
  syncing: boolean;
  /** Epoch ms of the last successful sync; null if never synced. */
  syncedAt: number | null;
  count: number;
  error: string | null;
  /** Bumped on every index change (sync or post-sale decrement). Consumers
   *  depend on this to re-run a search — the index itself lives in a ref. */
  version: number;
}

export interface CatalogApi extends CatalogState {
  /** Local browse. Only meaningful when `ready`. */
  search: (query: string, limit?: number) => CatalogItem[];
  /** Local scan; [] means a miss — the caller must ask the server. */
  scan: (code: string) => CatalogItem[];
  /** Decrement cached stock after a sale, keyed `productId:variantId`. */
  applySold: (sold: Map<string, number>) => void;
  /** Force a refresh (e.g. the cashier suspects the grid is stale). */
  resync: () => void;
}

export function useCatalog(
  storeId: string,
  locationId: string,
  /** Server-rendered first page, so the grid is never empty on a cold start. */
  seed: CatalogItem[] = [],
): CatalogApi {
  const key = catalogKey(storeId, locationId);
  const indexRef = useRef<CatalogIndex>(
    seed.length ? buildIndex(seed) : EMPTY_INDEX,
  );
  // Index lives in a ref (searching must not re-render); this counter is how
  // consumers learn it changed.
  const [state, setState] = useState<CatalogState>({
    ready: false,
    syncing: false,
    syncedAt: null,
    count: seed.length,
    error: null,
    version: 0,
  });

  const setIndex = useCallback((items: CatalogItem[]) => {
    indexRef.current = buildIndex(items);
    setState((s) => ({ ...s, version: s.version + 1 }));
  }, []);

  // Guards against two syncs overlapping (interval firing mid-sync) and
  // against a resolved sync writing into an unmounted register.
  const syncingRef = useRef(false);
  const aliveRef = useRef(true);

  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setState((s) => ({ ...s, syncing: true, error: null }));

    try {
      const items: CatalogItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await getCatalogSnapshot(cursor);
        if (res.error) {
          // Keep whatever cache we already have — a failed refresh must never
          // empty a working register.
          if (aliveRef.current)
            setState((s) => ({ ...s, syncing: false, error: res.error! }));
          return;
        }
        items.push(...res.items);
        cursor = res.nextCursor;
        if (!cursor || items.length >= MAX_ITEMS) break;
      }

      if (!aliveRef.current) return;
      const capped = items.slice(0, MAX_ITEMS);
      const syncedAt = Date.now();
      setIndex(capped);
      setState((s) => ({
        ...s,
        ready: true,
        syncing: false,
        syncedAt,
        count: capped.length,
        error: null,
      }));
      // Persist last: a failed write costs the next cold start, not this session.
      void writeCatalog(key, capped, syncedAt);
    } catch {
      if (aliveRef.current)
        setState((s) => ({
          ...s,
          syncing: false,
          error: "Catalog sync failed.",
        }));
    } finally {
      syncingRef.current = false;
    }
  }, [key, setIndex]);

  // Hydrate from IndexedDB, then sync. The cached index is live within a frame
  // or two of mount, so the first scan of the day doesn't wait on the network.
  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;

    void (async () => {
      const cached = await readCatalog(key);
      if (!cancelled && cached && cached.items.length > 0) {
        setIndex(cached.items);
        setState((s) => ({
          ...s,
          ready: true,
          syncedAt: cached.syncedAt,
          count: cached.items.length,
        }));
      }
      if (!cancelled) void sync();
    })();

    const t = setInterval(() => void sync(), RESYNC_MS);
    return () => {
      cancelled = true;
      aliveRef.current = false;
      clearInterval(t);
    };
  }, [key, sync, setIndex]);

  const search = useCallback(
    (query: string, limit = 24) => searchLocal(indexRef.current, query, limit),
    [],
  );
  const scan = useCallback(
    (code: string) => scanLocal(indexRef.current, code),
    [],
  );
  const applySold = useCallback(
    (sold: Map<string, number>) => {
      if (sold.size === 0) return;
      const next = applyStockDeltas(indexRef.current.all, sold);
      setIndex(next);
      // Best-effort: the interval sync will correct it regardless.
      void writeCatalog(key, next);
    },
    [key, setIndex],
  );

  return { ...state, search, scan, applySold, resync: () => void sync() };
}
