"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Loader2,
  MapPin,
  LogOut,
  Search,
  Trash2,
  Plus,
  Minus,
  X,
  ScanLine,
  Camera,
  Package,
  Database,
  UserPlus,
  UserRound,
  LayoutGrid,
  Banknote,
  Boxes,
} from "lucide-react";
import {
  lookupProducts,
  placePosSale,
  verifyManagerPin,
  type PosCatalogItem,
  type PosCustomer,
  type PosTender,
  type RegisterConfig,
} from "@/app/actions/pos-sale-actions";
import { CustomerPanel } from "./customer-panel";
import { posLock } from "@/app/actions/pos-auth-actions";
import { endSession } from "@/lib/auth/firebase-client";
import { isCameraScanSupported } from "@/lib/pos/barcode-camera";
import {
  createKeyboardWedge,
  isEditableTarget,
  isTouchPrimary,
  subscribeTouchPrimary,
} from "@/lib/pos/keyboard-wedge";
import { isIdleLockExempt } from "@/lib/pos/permissions";
import { useCatalog } from "@/lib/pos/use-catalog";
import {
  applyLayout,
  isOutOfStock,
  itemKey,
  layoutCoverage,
  type LayoutEntry,
} from "@/lib/pos/catalog-index";
import {
  getPosLayout,
  resetPosLayout,
  savePosLayout,
} from "@/app/actions/pos-layout-actions";
import { LayoutEditMode } from "./layout-editor";
import { IdleLock } from "../idle-lock";
import { TenderPanel } from "./tender-panel";
import { ReceiptOverlay } from "./receipt-overlay";
import { CameraScanner } from "./camera-scanner";
import { posTotals } from "@/lib/pos/totals";

export interface CartLine {
  key: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitPrice: number;
  quantity: number;
  /** Markdown on this line only, in rupees — for one damaged/expiring unit.
   *  Re-derived and capped server-side; this is a display value. */
  lineDiscount: number;
  /** Live stock at this location; null = untracked. */
  stock: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  /** Resolved to a rate via config.taxRates so the screen can quote the
   *  tax-inclusive total (see lib/pos/totals.ts). */
  taxClassId: string | null;
}

const lineKey = (p: string, v: string | null) => `${p}:${v ?? ""}`;

/** Camera support is fixed for the life of the page — nothing to subscribe to. */
const subscribeNever = () => () => {};

export function SellClient({
  config,
  idleLockMinutes,
  initialItems,
}: {
  config: RegisterConfig;
  idleLockMinutes: number;
  initialItems: PosCatalogItem[];
}) {
  const router = useRouter();
  // The local catalog: IndexedDB-backed, background-synced, seeded with the
  // server-rendered first page so the grid is populated before it warms up.
  const catalog = useCatalog(config.storeId, config.locationId, initialItems);
  // Grid contents from the SERVER fallback only. Once the cache is warm the
  // grid is derived from (query, index) during render — see `items` below.
  const [serverItems, setServerItems] =
    useState<PosCatalogItem[]>(initialItems);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tendering, setTendering] = useState(false);
  const [saleId, setSaleId] = useState<string | null>(null);
  // Disambiguation when one barcode maps to several variants.
  const [choices, setChoices] = useState<PosCatalogItem[] | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  // Customer attach (optional) + the B2B GSTIN that prints on the invoice.
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [gstin, setGstin] = useState("");
  const [customerOpen, setCustomerOpen] = useState(false);
  // Manager-arranged till grid. Empty = not configured = show everything.
  const [layout, setLayout] = useState<LayoutEntry[]>([]);
  const [canEditLayout, setCanEditLayout] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  // Feature-detected on the CLIENT only — the server can't know whether this
  // browser can scan, and rendering a button that does nothing is worse than
  // hiding it. useSyncExternalStore (rather than an effect) gives the server a
  // `false` snapshot, so hydration matches and no cascading render occurs;
  // the capability never changes, hence the no-op subscribe.
  const cameraSupported = useSyncExternalStore(
    subscribeNever,
    isCameraScanSupported,
    () => false,
  );

  // Load the till arrangement once. A failure is non-fatal: getPosLayout
  // returns an empty layout, and the register shows the whole catalogue rather
  // than an empty grid.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getPosLayout();
      if (cancelled) return;
      setLayout(res.items);
      setCanEditLayout(res.canEdit);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A hardware scanner is a keyboard: it "types" the barcode then hits Enter.
  // Keeping this input focused means a scan lands in the cart with no clicks —
  // the single biggest factor in per-sale time.
  //
  // ★ BUT ONLY WHERE THERE IS A REAL KEYBOARD. On a touch-primary device the
  // same trick is the thing cashiers complain about: every tap on a product
  // blurs the box, focus is taken straight back, and iPadOS answers a
  // programmatic focus by opening the software keyboard over half the till. Tap
  // a product, get a keyboard. So sticky focus is switched off there and the
  // wedge below carries the scanner instead — a tablet does not lose scanning,
  // it stops being interrupted.
  const touchPrimary = useSyncExternalStore(
    subscribeTouchPrimary,
    isTouchPrimary,
    () => false,
  );
  const scanRef = useRef<HTMLInputElement>(null);
  // Every overlay is listed: each one owns an input of its own (tender amount,
  // customer search) and pulling focus out from under it 80 ms later would make
  // that field impossible to type in.
  const overlayOpen =
    tendering ||
    !!choices ||
    cameraOpen ||
    layoutOpen ||
    customerOpen ||
    !!saleId;
  const refocus = useCallback(() => {
    if (touchPrimary || overlayOpen) return;
    scanRef.current?.focus();
  }, [touchPrimary, overlayOpen]);
  useEffect(() => {
    refocus();
  }, [refocus, cart.length]);

  const addItem = useCallback((it: PosCatalogItem) => {
    const label = it.variantName ? `${it.name} (${it.variantName})` : it.name;
    // Clamp to stock at THIS location unless the SKU is untracked or
    // backorderable. The server re-checks; this only avoids ringing up what
    // can't be sold. Every rejection MUST say why — silently doing nothing
    // after a scan looks like the scanner is broken.
    const cap =
      it.trackInventory && !it.allowBackorder ? (it.stock ?? 0) : Infinity;
    if (cap < 1) {
      setError(`${label} is out of stock at this location.`);
      return;
    }
    setError(null);
    setCart((c) => {
      const key = lineKey(it.productId, it.variantId);
      const found = c.find((l) => l.key === key);
      if (found) {
        if (found.quantity + 1 > cap) {
          setError(`Only ${cap} of ${label} left at this location.`);
          return c;
        }
        return c.map((l) =>
          l.key === key ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [
        ...c,
        {
          key,
          productId: it.productId,
          variantId: it.variantId,
          name: it.name,
          variantName: it.variantName,
          unitPrice: it.price,
          taxClassId: it.taxClassId ?? null,
          quantity: 1,
          lineDiscount: 0,
          stock: it.stock,
          trackInventory: it.trackInventory,
          allowBackorder: it.allowBackorder,
        },
      ];
    });
  }, []);

  /** One scanned/typed code resolved to zero, one, or several SKUs. */
  const resolveScan = useCallback(
    (found: PosCatalogItem[]): boolean => {
      if (found.length === 1) {
        addItem(found[0]);
        setQuery("");
        return true;
      }
      if (found.length > 1) {
        // Several SKUs share this code — make the cashier pick rather than
        // guessing (mislabelled supplier barcodes are common).
        setChoices(found);
        setQuery("");
        return true;
      }
      return false;
    },
    [addItem],
  );

  // Enter (or a hardware scanner's trailing Enter) = a scan.
  const runScan = useCallback(
    async (code: string) => {
      setError(null);
      // Local first: this is the path that makes a scan land in the cart in
      // <50 ms with no network at all.
      if (catalog.ready && resolveScan(catalog.scan(code))) return;

      // A local MISS is not an answer — the product may have been created
      // since the last sync. Ask the server before telling the cashier no.
      setSearching(true);
      const res = await lookupProducts(code);
      setSearching(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (!resolveScan(res.items)) setError(`Nothing found for "${code}".`);
    },
    [catalog, resolveScan],
  );

  // The scan path that needs NO focused input. On a desktop this never fires —
  // the search box holds focus, so `isEditableTarget` sends every key to it and
  // behaviour is exactly as before. On a tablet it is the whole scanner story:
  // the cashier taps products with their finger, focus lives wherever the last
  // tap left it, and a scan still drops into the cart.
  //
  // Swallowing the burst matters as much as reading it. After a tap the product
  // tile is the focused element, and both Space and Enter activate a focused
  // button — so an unhandled scan would ring up the tapped product a second
  // time instead of the scanned one.
  useEffect(() => {
    const wedge = createKeyboardWedge();
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen) return;
      // A shortcut or a paste is not a scan.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const res = wedge.handleKey(e.key, e.timeStamp);
      if (res.type === "ignored") return;
      e.preventDefault();
      if (res.type === "scan") void runScan(res.code);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpen, runScan]);

  // Browse-as-you-type. Against the local index the grid is DERIVED, not
  // stored: recomputing during render costs ~1 ms at a few thousand SKUs and
  // removes any chance of the grid disagreeing with the index. catalog.version
  // is the dependency that picks up a sync or a post-sale stock decrement.
  const trimmedQuery = query.trim();
  const items = useMemo(() => {
    // Searching ALWAYS spans the whole catalogue. The layout decides what the
    // IDLE grid shows; it must never decide what can be found and sold, or the
    // products a manager left off the till could never be rung up at all.
    if (trimmedQuery) {
      if (catalog.ready) return catalog.search(trimmedQuery);
      // The server path has no index to order it, so apply the same rule here —
      // otherwise the grid would reshuffle the moment the cache warms up.
      return [
        ...serverItems.filter((i) => !isOutOfStock(i)),
        ...serverItems.filter(isOutOfStock),
      ];
    }
    return applyLayout(catalog.ready ? catalog.all() : serverItems, layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    catalog.ready,
    catalog.version,
    catalog.search,
    catalog.all,
    trimmedQuery,
    serverItems,
    layout,
  ]);

  const coverage = useMemo(
    () => layoutCoverage(catalog.ready ? catalog.all() : serverItems, layout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog.ready, catalog.version, catalog.all, serverItems, layout],
  );

  // The server path exists only until the cache warms up (and on a device
  // where IndexedDB is unavailable, where it stays the permanent path).
  useEffect(() => {
    if (catalog.ready) return;
    const t = setTimeout(
      async () => {
        setSearching(true);
        const res = await lookupProducts(trimmedQuery);
        setSearching(false);
        if (res.error) setError(res.error);
        else setServerItems(res.items);
      },
      trimmedQuery ? 220 : 150,
    );
    return () => clearTimeout(t);
  }, [trimmedQuery, catalog.ready]);

  const setLineDiscount = (key: string, value: number) =>
    setCart((c) =>
      c.map((l) =>
        l.key === key
          ? // Never let a markdown exceed the line — the server caps it too,
            // but a negative line total on screen is just wrong.
            {
              ...l,
              lineDiscount: Math.min(
                Math.max(0, value),
                l.unitPrice * l.quantity,
              ),
            }
          : l,
      ),
    );

  const setQty = (key: string, delta: number) =>
    setCart((c) =>
      c.flatMap((l) => {
        if (l.key !== key) return [l];
        const cap =
          l.trackInventory && !l.allowBackorder ? (l.stock ?? 0) : Infinity;
        const next = Math.min(l.quantity + delta, cap);
        return next <= 0 ? [] : [{ ...l, quantity: next }];
      }),
    );

  // A product with no class of its own falls back to the store default —
  // mirroring how placePosSale resolves the rate.
  const rateForClass = (id: string | null) => {
    const cls = id ?? config.defaultTaxClassId;
    return cls ? (config.taxRates[cls] ?? 0) : 0;
  };

  // The SAME pure helper placePosSale charges with — including tax. Quoting the
  // pre-tax subtotal here (as this screen used to) meant the cashier promised
  // the customer one number and the till charged another, so the change handed
  // back was wrong by exactly the tax.
  const totals = posTotals({
    lines: cart.map((l) => ({
      gross: l.unitPrice * l.quantity,
      lineDiscount: l.lineDiscount,
      rate: rateForClass(l.taxClassId),
    })),
    requestedOrderDiscount: discount,
    pricesIncludeTax: config.pricesIncludeTax,
    taxEnabled: config.taxEnabled,
  });
  const { subtotal, lineDiscountTotal, tax } = totals;
  const cappedDiscount = totals.orderDiscount;
  const estTotal = totals.total;

  const completeSale = async (
    tenders: PosTender[],
    managerApproved?: boolean,
  ): Promise<{ error?: string; needsApproval?: boolean }> => {
    const res = await placePosSale(
      cart.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        quantity: l.quantity,
        lineDiscount: l.lineDiscount || undefined,
      })),
      tenders,
      {
        orderDiscount: cappedDiscount,
        managerApproved,
        customerId: customer?.id ?? null,
        customerGstin: gstin.trim() || null,
      },
    );
    if (res.error) {
      return { error: res.error, needsApproval: res.needsApproval };
    }
    // Reflect the sale in the local catalog at once — the next scan of the
    // same SKU shows the new on-hand without waiting for the 5-min sync.
    catalog.applySold(new Map(cart.map((l) => [itemKey(l), l.quantity])));
    setCart([]);
    setDiscount(0);
    setCustomer(null);
    setGstin("");
    setTendering(false);
    setSaleId(res.orderId ?? null);
    router.refresh();
    return {};
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Owners are exempt, as on the POS home: idle-lock targets the
          walked-away-from-a-shared-till risk, and since posLock now ends the
          Firebase session it would otherwise sign an owner out of the
          dashboard for standing still. */}
      {/* Only the SUPERADMIN is exempt now. A delegated admin at a shared
          counter is the same walked-away-from-an-open-till risk as any
          operator — more so, since their session reaches further than a
          cashier's. Note the cost that buys: posLock clears sm_session, so an
          idle till signs them out of the dashboard too. That is the intended
          trade for everyone except the person whose shop it is. */}
      {!isIdleLockExempt(config.role) && <IdleLock minutes={idleLockMinutes} />}

      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2 font-semibold">
          <ScanLine className="h-5 w-5" strokeWidth={2} />
          Register
        </div>
        <div className="flex items-center gap-3 text-sm">
          {/* Cache state, deliberately quiet. A cashier only needs it when
              something looks wrong — hence the click-to-refresh. */}
          <button
            type="button"
            onClick={catalog.resync}
            disabled={catalog.syncing}
            title={
              catalog.ready
                ? `${catalog.count} products cached on this device. Click to refresh.`
                : "Loading the catalog…"
            }
            className="hidden items-center gap-1.5 rounded-lg px-2 py-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/70 disabled:opacity-60 sm:inline-flex"
          >
            {catalog.syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Database className="h-3.5 w-3.5" strokeWidth={2} />
            )}
            {catalog.ready ? catalog.count : "…"}
          </button>
          {/* "12 of 20" — a manager can see at a glance that eight products
              are reachable only by search or scan. Hidden until configured,
              since "20 of 20" is noise. */}
          {coverage.configured && (
            <span className="hidden text-white/40 sm:inline">
              {coverage.shown} of {coverage.total} products
            </span>
          )}
          {canEditLayout && (
            <button
              type="button"
              onClick={() => setLayoutOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 font-medium transition-colors hover:bg-white/20"
            >
              <LayoutGrid className="h-4 w-4" strokeWidth={2} />
              <span className="hidden sm:inline">Edit layout</span>
            </button>
          )}
          {canEditLayout && (
            <Link
              href="/pos/inventory"
              title="Stock at this location"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 font-medium transition-colors hover:bg-white/20"
            >
              <Boxes className="h-4 w-4" strokeWidth={2} />
              <span className="hidden sm:inline">Stock</span>
            </Link>
          )}
          <Link
            href="/pos/shift"
            title="Cash drawer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 font-medium transition-colors hover:bg-white/20"
          >
            <Banknote className="h-4 w-4" strokeWidth={2} />
            <span className="hidden sm:inline">Drawer</span>
          </Link>
          <span className="flex items-center gap-1.5 text-white/70">
            <MapPin className="h-4 w-4" strokeWidth={2} />
            {config.locationName}
          </span>
          <span className="rounded-full bg-white/10 px-3 py-1">
            {config.operatorName}
          </span>
          <button
            type="button"
            onClick={async () => {
              await posLock();
              // Also sign the Firebase SDK out locally, so nothing can re-mint
              // a session for the person who just walked away.
              await endSession();
              router.replace("/pos/login");
              router.refresh();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 font-medium transition-colors hover:bg-white/20"
          >
            <LogOut className="h-4 w-4" strokeWidth={2} />
            Lock
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Catalog */}
        <div className="flex min-w-0 flex-1 flex-col p-3">
          {layoutOpen ? (
            <LayoutEditMode
              catalog={catalog.ready ? catalog.all() : serverItems}
              initial={layout}
              saving={savingLayout}
              onClose={() => setLayoutOpen(false)}
              onSave={async (next) => {
                setSavingLayout(true);
                const res = await savePosLayout(next);
                setSavingLayout(false);
                if (res.error) {
                  setError(res.error);
                  return;
                }
                setLayout(next);
                setLayoutOpen(false);
              }}
              onReset={async () => {
                setSavingLayout(true);
                const res = await resetPosLayout();
                setSavingLayout(false);
                if (res.error) {
                  setError(res.error);
                  return;
                }
                setLayout([]);
                setLayoutOpen(false);
              }}
            />
          ) : (
            <>
              <div className="mb-3 flex shrink-0 gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                  <input
                    ref={scanRef}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setError(null);
                    }}
                    // No autoFocus: on a tablet it opens the software keyboard
                    // the moment the register loads. The mount pass of the
                    // effect above focuses it where sticky focus applies.
                    onBlur={() => setTimeout(refocus, 80)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && query.trim()) {
                        e.preventDefault();
                        void runScan(query.trim());
                      }
                    }}
                    placeholder="Scan a barcode or search products…"
                    className="w-full rounded-xl border border-white/15 bg-white/5 py-3 pl-9 pr-3 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-white/40" />
                  )}
                </div>
                {/* Only rendered where the browser can actually scan — a dead
                button is worse than none. */}
                {cameraSupported && (
                  <button
                    type="button"
                    onClick={() => setCameraOpen(true)}
                    title="Scan with the camera"
                    className="flex shrink-0 items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-medium transition-colors hover:bg-white/10"
                  >
                    <Camera className="h-5 w-5" strokeWidth={2} />
                    <span className="hidden sm:inline">Scan</span>
                  </button>
                )}
              </div>

              {error && (
                <div className="mb-3 shrink-0 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">
                  {error}
                </div>
              )}

              <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {items.map((it) => {
                  const out = isOutOfStock(it);
                  return (
                    <button
                      key={lineKey(it.productId, it.variantId)}
                      type="button"
                      disabled={out}
                      onClick={() => addItem(it)}
                      className="flex flex-col rounded-xl border border-white/10 bg-white/5 p-2 text-left transition-colors hover:bg-white/10 disabled:opacity-40"
                    >
                      {/* Photos make the grid scannable by eye for items without a
                      barcode (loose produce, bakery). A FIXED short height, not
                      aspect-square: on a wide till screen a square tile grew to
                      ~350px and pushed the price below the fold, so the cashier
                      scrolled to find what should be one tap away. */}
                      <div className="mb-2 h-24 w-full overflow-hidden rounded-lg bg-white/5 sm:h-28">
                        {it.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={it.image}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-white/20">
                            <Package className="h-8 w-8" strokeWidth={1.5} />
                          </div>
                        )}
                      </div>
                      <span className="line-clamp-2 text-sm font-medium">
                        {it.name}
                      </span>
                      {it.variantName && (
                        <span className="text-xs text-white/50">
                          {it.variantName}
                        </span>
                      )}
                      <span className="mt-auto pt-2 font-semibold">
                        ₹{it.price.toLocaleString("en-IN")}
                      </span>
                      <span className="text-[11px] text-white/40">
                        {out
                          ? "Out of stock"
                          : it.trackInventory
                            ? `${it.stock} in stock`
                            : ""}
                      </span>
                    </button>
                  );
                })}
                {items.length === 0 && !searching && (
                  <p className="col-span-full py-10 text-center text-sm text-white/40">
                    No products match.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Cart */}
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-white/10 bg-black/20">
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {cart.length === 0 ? (
              <p className="py-16 text-center text-sm text-white/40">
                Scan or tap a product to start a sale.
              </p>
            ) : (
              cart.map((l) => (
                <div
                  key={l.key}
                  className="mb-2 rounded-xl border border-white/10 bg-white/5 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {l.name}
                      </div>
                      {l.variantName && (
                        <div className="text-xs text-white/50">
                          {l.variantName}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setCart((c) => c.filter((x) => x.key !== l.key))
                      }
                      className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setQty(l.key, -1)}
                        className="rounded-lg bg-white/10 p-1.5 hover:bg-white/20"
                        aria-label="Decrease"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="w-8 text-center text-sm">
                        {l.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => setQty(l.key, 1)}
                        className="rounded-lg bg-white/10 p-1.5 hover:bg-white/20"
                        aria-label="Increase"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                    <span
                      className={
                        l.lineDiscount > 0
                          ? "text-sm text-white/40 line-through"
                          : "font-semibold"
                      }
                    >
                      ₹{(l.unitPrice * l.quantity).toLocaleString("en-IN")}
                    </span>
                  </div>
                  {/* Per-line markdown — for the one damaged or expiring unit,
                      as opposed to a discount across the whole sale. Hidden
                      unless this operator may discount: a field that always
                      fails at the till, in front of a customer, is worse than
                      no field. The server is the actual boundary. */}
                  {config.canDiscount && (
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                      <label className="flex items-center gap-1.5 text-white/50">
                        Less ₹
                        <input
                          value={l.lineDiscount || ""}
                          inputMode="numeric"
                          onChange={(e) =>
                            setLineDiscount(
                              l.key,
                              Number(e.target.value.replace(/\D/g, "")) || 0,
                            )
                          }
                          placeholder="0"
                          className="w-16 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-right text-white outline-none focus:border-white/40"
                        />
                      </label>
                      {l.lineDiscount > 0 && (
                        <span className="font-semibold text-white">
                          ₹
                          {(
                            l.unitPrice * l.quantity -
                            l.lineDiscount
                          ).toLocaleString("en-IN")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="shrink-0 border-t border-white/10 p-3">
            {/* Optional: a sale completes fine without a customer. */}
            <button
              type="button"
              onClick={() => setCustomerOpen(true)}
              className="mb-3 flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10"
            >
              {customer ? (
                <>
                  <UserRound className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span className="min-w-0 flex-1 truncate">
                    {customer.name}
                  </span>
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4 shrink-0 text-white/40" />
                  <span className="flex-1 text-white/50">Add customer</span>
                </>
              )}
              {gstin && (
                <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] tracking-wide text-white/60">
                  GST
                </span>
              )}
            </button>

            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-white/60">Subtotal</span>
              <span>₹{subtotal.toLocaleString("en-IN")}</span>
            </div>
            {lineDiscountTotal > 0 && (
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-white/60">Line discounts</span>
                <span>−₹{lineDiscountTotal.toLocaleString("en-IN")}</span>
              </div>
            )}
            {config.canDiscount && (
              <label className="mb-2 flex items-center justify-between gap-2 text-sm">
                <span className="text-white/60">Discount ₹</span>
                <input
                  value={discount || ""}
                  inputMode="numeric"
                  onChange={(e) =>
                    setDiscount(Number(e.target.value.replace(/\D/g, "")) || 0)
                  }
                  placeholder="0"
                  className="w-24 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-right outline-none focus:border-white/40"
                />
              </label>
            )}
            {tax > 0 && (
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-white/60">
                  Tax{config.pricesIncludeTax ? " (included)" : ""}
                </span>
                <span>₹{tax.toLocaleString("en-IN")}</span>
              </div>
            )}
            <div className="mb-3 flex items-center justify-between text-lg font-bold">
              <span>Total</span>
              <span>₹{estTotal.toLocaleString("en-IN")}</span>
            </div>
            <button
              type="button"
              disabled={cart.length === 0}
              onClick={() => setTendering(true)}
              className="w-full rounded-xl bg-emerald-600 py-3 font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
            >
              Charge ₹{estTotal.toLocaleString("en-IN")}
            </button>
          </div>
        </aside>
      </div>

      {/* Duplicate-barcode disambiguation */}
      {choices && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#12171f] p-5">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold">Which item?</h2>
              <button
                type="button"
                onClick={() => setChoices(null)}
                className="rounded p-1 text-white/50 hover:bg-white/10"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 text-sm text-white/60">
              Several products share this code.
            </p>
            <div className="space-y-2">
              {choices.map((c) => (
                <button
                  key={lineKey(c.productId, c.variantId)}
                  type="button"
                  onClick={() => {
                    addItem(c);
                    setChoices(null);
                    setQuery("");
                  }}
                  className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 p-3 text-left hover:bg-white/10"
                >
                  <span>
                    <span className="block text-sm font-medium">{c.name}</span>
                    <span className="block text-xs text-white/50">
                      {c.variantName ?? c.sku}
                      {c.trackInventory ? ` · ${c.stock} in stock` : ""}
                    </span>
                  </span>
                  <span className="font-semibold">
                    ₹{c.price.toLocaleString("en-IN")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* A camera scan takes the IDENTICAL path as a hardware scan, so
          duplicate-barcode disambiguation and "not found" behave the same. */}
      {cameraOpen && (
        <CameraScanner
          onScan={(code) => void runScan(code)}
          onClose={() => setCameraOpen(false)}
        />
      )}

      {customerOpen && (
        <CustomerPanel
          customer={customer}
          gstin={gstin}
          gstEnabled={config.gstEnabled}
          onPick={setCustomer}
          onGstin={setGstin}
          onClose={() => setCustomerOpen(false)}
        />
      )}

      {tendering && (
        <TenderPanel
          total={estTotal}
          onCancel={() => setTendering(false)}
          onComplete={completeSale}
          onVerifyManager={verifyManagerPin}
        />
      )}

      {saleId && (
        <ReceiptOverlay orderId={saleId} onClose={() => setSaleId(null)} />
      )}
    </div>
  );
}
