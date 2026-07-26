"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
} from "lucide-react";
import {
  lookupProducts,
  placePosSale,
  verifyManagerPin,
  type PosCatalogItem,
  type PosTender,
  type RegisterConfig,
} from "@/app/actions/pos-sale-actions";
import { posLock } from "@/app/actions/pos-auth-actions";
import { isCameraScanSupported } from "@/lib/pos/barcode-camera";
import { IdleLock } from "../idle-lock";
import { TenderPanel } from "./tender-panel";
import { ReceiptOverlay } from "./receipt-overlay";
import { CameraScanner } from "./camera-scanner";

export interface CartLine {
  key: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitPrice: number;
  quantity: number;
  /** Live stock at this location; null = untracked. */
  stock: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
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
  const [items, setItems] = useState<PosCatalogItem[]>(initialItems);
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

  // A hardware scanner is a keyboard: it "types" the barcode then hits Enter.
  // Keeping this input focused means a scan lands in the cart with no clicks —
  // the single biggest factor in per-sale time.
  const scanRef = useRef<HTMLInputElement>(null);
  const refocus = useCallback(() => {
    // Don't steal focus while a modal owns the screen — grabbing it back would
    // fight the camera view and the tender inputs.
    if (!tendering && !choices && !cameraOpen) scanRef.current?.focus();
  }, [tendering, choices, cameraOpen]);
  useEffect(() => {
    refocus();
  }, [refocus, cart.length]);

  const addItem = useCallback((it: PosCatalogItem) => {
    setError(null);
    setCart((c) => {
      const key = lineKey(it.productId, it.variantId);
      const found = c.find((l) => l.key === key);
      // Clamp to live stock unless the SKU is untracked or backorderable —
      // the server re-checks, this just avoids ringing what can't be sold.
      const cap =
        it.trackInventory && !it.allowBackorder ? (it.stock ?? 0) : Infinity;
      if (found) {
        if (found.quantity + 1 > cap) return c;
        return c.map((l) =>
          l.key === key ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      if (cap < 1) return c;
      return [
        ...c,
        {
          key,
          productId: it.productId,
          variantId: it.variantId,
          name: it.name,
          variantName: it.variantName,
          unitPrice: it.price,
          quantity: 1,
          stock: it.stock,
          trackInventory: it.trackInventory,
          allowBackorder: it.allowBackorder,
        },
      ];
    });
  }, []);

  const runSearch = useCallback(
    async (q: string, fromScan: boolean) => {
      setSearching(true);
      setError(null);
      const res = await lookupProducts(q);
      setSearching(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (fromScan) {
        if (res.items.length === 1) {
          addItem(res.items[0]);
          setQuery("");
          return;
        }
        if (res.items.length === 0) {
          setError(`Nothing found for "${q}".`);
          return;
        }
        // Several SKUs share this code — make the cashier pick rather than
        // guessing (mislabelled supplier barcodes are common).
        setChoices(res.items);
        return;
      }
      setItems(res.items);
    },
    [addItem],
  );

  // Debounced browse-as-you-type; Enter is treated as a scan.
  useEffect(() => {
    if (!query) {
      const t = setTimeout(() => void runSearch("", false), 150);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => void runSearch(query, false), 220);
    return () => clearTimeout(t);
  }, [query, runSearch]);

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

  const subtotal = cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const cappedDiscount = Math.min(Math.max(0, discount), subtotal);
  // Display-only estimate; placePosSale recomputes tax authoritatively.
  const estTotal = Math.max(0, subtotal - cappedDiscount);

  const completeSale = async (
    tenders: PosTender[],
    managerApproved?: boolean,
  ): Promise<{ error?: string; needsApproval?: boolean }> => {
    const res = await placePosSale(
      cart.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        quantity: l.quantity,
      })),
      tenders,
      { orderDiscount: cappedDiscount, managerApproved },
    );
    if (res.error) {
      return { error: res.error, needsApproval: res.needsApproval };
    }
    setCart([]);
    setDiscount(0);
    setTendering(false);
    setSaleId(res.orderId ?? null);
    router.refresh();
    return {};
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <IdleLock minutes={idleLockMinutes} />

      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2 font-semibold">
          <ScanLine className="h-5 w-5" strokeWidth={2} />
          Register
        </div>
        <div className="flex items-center gap-3 text-sm">
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
          <div className="mb-3 flex shrink-0 gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              <input
                ref={scanRef}
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => setTimeout(refocus, 80)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && query.trim()) {
                    e.preventDefault();
                    void runSearch(query.trim(), true);
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

          <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
            {items.map((it) => {
              const out =
                it.trackInventory && !it.allowBackorder && (it.stock ?? 0) <= 0;
              return (
                <button
                  key={lineKey(it.productId, it.variantId)}
                  type="button"
                  disabled={out}
                  onClick={() => addItem(it)}
                  className="flex flex-col rounded-xl border border-white/10 bg-white/5 p-3 text-left transition-colors hover:bg-white/10 disabled:opacity-40"
                >
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
                    <span className="font-semibold">
                      ₹{(l.unitPrice * l.quantity).toLocaleString("en-IN")}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="shrink-0 border-t border-white/10 p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-white/60">Subtotal</span>
              <span>₹{subtotal.toLocaleString("en-IN")}</span>
            </div>
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
            <div className="mb-3 flex items-center justify-between text-lg font-bold">
              <span>Total</span>
              <span>₹{estTotal.toLocaleString("en-IN")}</span>
            </div>
            <p className="mb-2 text-[11px] text-white/40">
              Tax is calculated on the server when the sale completes.
            </p>
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
          onScan={(code) => void runSearch(code, true)}
          onClose={() => setCameraOpen(false)}
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
