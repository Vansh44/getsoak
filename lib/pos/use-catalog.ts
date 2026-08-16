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
import { usePoll } from "./use-poll";
import type { PollRun } from "./use-poll";
import { fetchCatalogPage } from "./live";

/**
 * Stock drifts all day on a register left open; re-sync often enough that the
 * grid isn't lying, rarely enough that it's invisible on a shop's wifi.
 *
 * ★ WHY THIS STAYS MINUTES, NOT SECONDS. A sync is keyset-paged at 300 products
 * a page, so a large catalogue is several requests — running that on a short
 * timer, on every till, to keep a DISPLAY number fresh is the wrong trade.
 * Nothing cached is authoritative: `placePosSale` re-reads price and re-reserves
 * stock, so staleness here is a wrong label at worst, never a wrong charge or an
 * oversell. What actually made it feel stale was the timer being blind — it kept
 * ticking in a hidden tab and into a dead network, and the first sync after
 * someone came back was up to five minutes away. `usePoll` fixes that end: the
 * catch-up is immediate, which is the moment staleness is noticed.
 */
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
  /** Every cached SKU, in catalogue order — the idle grid and the layout
   *  editor both work from the whole list rather than a search result. */
  all: () => CatalogItem[];
  /** One SKU by its ids. Used when resuming a held sale, which stores CHOICES
   *  and re-prices from the catalogue rather than trusting a stored price. */
  byId: (productId: string, variantId: string | null) => CatalogItem | null;
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

  const sync = useCallback(
    async (run?: PollRun) => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      setState((s) => ({ ...s, syncing: true, error: null }));

      try {
        const items: CatalogItem[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await fetchCatalogPage(cursor, run?.signal);
          if (!res || res.error) {
            // Keep whatever cache we already have — a failed refresh must never
            // empty a working register.
            if (aliveRef.current && (!run || run.isCurrent()))
              setState((s) => ({
                ...s,
                syncing: false,
                error: res?.error ?? "Catalog sync failed.",
              }));
            return;
          }
          items.push(...res.items);
          cursor = res.nextCursor;
          if (!cursor || items.length >= MAX_ITEMS) break;
        }

        if (!aliveRef.current || (run && !run.isCurrent())) return;
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
    },
    [key, setIndex],
  );

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

    return () => {
      cancelled = true;
      aliveRef.current = false;
    };
  }, [key, sync, setIndex]);

  // ★ THE RE-SYNC IS A `usePoll`, NOT A BARE setInterval. It used to be one, and
  // a bare interval is blind in the two ways that matter on a till: it keeps
  // firing in a hidden tab and into a dead network (each attempt failing
  // silently and setting the "Catalog sync failed" state nobody is looking at),
  // and after the shop's wifi comes back the next attempt is up to five minutes
  // away. Now it pauses on both and catches up the instant either recovers —
  // which is exactly when a cashier returns to the screen and expects the
  // numbers to be true.
  //
  // ★★ AND THE CATCH-UP THROTTLE MATTERS MOST HERE. This is the heaviest poller
  // in the register — a sync is keyset-paged at 300 products a page, so a large
  // catalogue is several requests — and `visibilitychange` fires on EVERY tab
  // switch. Unthrottled, somebody flipping between two tabs would kick off a
  // full catalogue re-read on every flip. `usePoll` skips a catch-up when the
  // last run was inside one interval, which is the right rule: the interval IS
  // the freshness this promises. (`syncingRef` inside `sync` stops two
  // OVERLAPPING syncs; it does nothing about ten sequential ones.)
  //
  // No `backOff`: `sync` does not diff, so it cannot report whether anything
  // changed, and a poller that guesses would slow itself down on no evidence.
  usePoll(sync, RESYNC_MS);

  const search = useCallback(
    (query: string, limit = 24) => searchLocal(indexRef.current, query, limit),
    [],
  );
  const scan = useCallback(
    (code: string) => scanLocal(indexRef.current, code),
    [],
  );
  const all = useCallback(() => indexRef.current.all, []);
  // Linear over the cached list, like `searchLocal` and for the same reason:
  // a resume looks up a handful of lines once, so an extra index to keep in
  // step through every sync would cost more than it saves.
  const byId = useCallback(
    (productId: string, variantId: string | null) =>
      indexRef.current.all.find(
        (i) => i.productId === productId && (i.variantId ?? null) === variantId,
      ) ?? null,
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

  return {
    ...state,
    search,
    scan,
    all,
    byId,
    applySold,
    resync: () => void sync(),
  };
}
