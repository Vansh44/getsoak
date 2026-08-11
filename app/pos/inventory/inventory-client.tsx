"use client";

// POS Phase 4 — stock from the shop floor.
//
// Built for someone holding a shelf, not sitting at a desk: search or scan to
// find the SKU, then one of three actions on the row itself. The dashboard's
// inventory page is the desk view; this one answers "how many are actually
// here, and let me fix it".

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  Loader2,
  Minus,
  Package,
  Plus,
  Search,
  Send,
  TriangleAlert,
} from "lucide-react";
import { PosScreen } from "../pos-screen";
import {
  adjustPosStock,
  countPosStock,
  transferPosStock,
  type PosInventoryItem,
  type PosTransferTarget,
} from "@/app/actions/pos-inventory-actions";
import { getPosInventory } from "@/app/actions/pos-inventory-actions";

type Mode = "receive" | "count" | "transfer";

const MODE_META: Record<Mode, { label: string; verb: string }> = {
  receive: { label: "Receive / correct", verb: "Apply" },
  count: { label: "Count", verb: "Save count" },
  transfer: { label: "Send to…", verb: "Send" },
};

export function InventoryClient({
  initial,
  targets,
  locationName,
}: {
  initial: PosInventoryItem[];
  targets: PosTransferTarget[];
  locationName: string;
}) {
  const [items, setItems] = useState(initial);
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (q: string, low: boolean) => {
    setLoading(true);
    const res = await getPosInventory({ query: q, lowOnly: low });
    setLoading(false);
    if (res.error) setError(res.error);
    else setItems(res.items);
  }, []);

  // Skip the first run: the server already rendered `initial`, and refetching
  // on mount is a wasted round-trip plus a visible flash of re-sorted rows.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => void refresh(query.trim(), lowOnly), 250);
    return () => clearTimeout(t);
  }, [query, lowOnly, refresh]);

  const done = (msg: string) => {
    setNotice(msg);
    setOpenKey(null);
    setError(null);
    void refresh(query.trim(), lowOnly);
    setTimeout(() => setNotice(null), 3000);
  };

  return (
    // Chrome from PosScreen — the "Back to register" button is gone with it:
    // the rail goes to the register, or anywhere else, in the same one tap.
    <PosScreen title="Stock" subtitle={locationName} width="narrow">
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
          <input
            ref={searchRef}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Scan or search…"
            className="w-full rounded-xl border border-white/15 bg-white/5 py-2.5 pl-9 pr-3 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-white/40" />
          )}
        </div>
        <button
          type="button"
          onClick={() => setLowOnly((v) => !v)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition-colors ${
            lowOnly
              ? "bg-amber-500 text-black"
              : "bg-white/10 hover:bg-white/20"
          }`}
        >
          <TriangleAlert className="h-4 w-4" strokeWidth={2} />
          Low
        </button>
      </div>

      {notice && (
        <p className="mb-3 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="space-y-2">
        {items.map((it) => {
          const key = `${it.productId}:${it.variantId ?? ""}`;
          return (
            <Row
              key={key}
              item={it}
              targets={targets}
              open={openKey === key}
              onToggle={() => {
                setOpenKey(openKey === key ? null : key);
                setError(null);
              }}
              onError={setError}
              onDone={done}
            />
          );
        })}
        {items.length === 0 && !loading && (
          <p className="py-10 text-center text-sm text-white/40">
            {lowOnly ? "Nothing is running low." : "No products match."}
          </p>
        )}
      </div>
    </PosScreen>
  );
}

function Row({
  item,
  targets,
  open,
  onToggle,
  onError,
  onDone,
}: {
  item: PosInventoryItem;
  targets: PosTransferTarget[];
  open: boolean;
  onToggle: () => void;
  onError: (msg: string) => void;
  onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("receive");
  const [value, setValue] = useState("");
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  const label = item.variantName
    ? `${item.name} · ${item.variantName}`
    : item.name;
  const n = Number(value);
  const valid = Number.isInteger(n) && (mode === "count" ? n >= 0 : n > 0);

  const submit = () =>
    start(async () => {
      const res =
        mode === "count"
          ? await countPosStock(item.productId, item.variantId, n, note)
          : mode === "receive"
            ? await adjustPosStock(
                item.productId,
                item.variantId,
                n,
                "received",
                note,
              )
            : await transferPosStock(
                item.productId,
                item.variantId,
                n,
                target,
                note,
              );
      if (res.error) {
        onError(res.error);
        return;
      }
      setValue("");
      setNote("");
      onDone(
        mode === "transfer"
          ? `Sent ${n} × ${label}`
          : `${label} is now ${"newStock" in res ? res.newStock : n}`,
      );
    });

  // Quick −1 / +1 for the common case: one broken jar, one found tin.
  const quick = (delta: number) =>
    start(async () => {
      const res = await adjustPosStock(
        item.productId,
        item.variantId,
        delta,
        "adjustment",
      );
      if (res.error) onError(res.error);
      else onDone(`${label} is now ${res.newStock}`);
    });

  return (
    <div className="rounded-xl border border-white/10 bg-white/5">
      <div className="flex items-center gap-3 p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/5">
          {item.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.image}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <Package className="h-4 w-4 text-white/30" strokeWidth={1.5} />
          )}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-xs text-white/50">
            {item.sku ?? item.barcode ?? "—"}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {item.low && (
            <TriangleAlert
              className="h-4 w-4 text-amber-400"
              strokeWidth={2}
              aria-label="Low stock"
            />
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => quick(-1)}
            aria-label={`One less ${label}`}
            className="rounded-lg bg-white/10 p-1.5 transition-colors hover:bg-white/20 disabled:opacity-40"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span
            className={`w-10 text-center text-lg font-bold ${
              item.low ? "text-amber-400" : ""
            }`}
          >
            {item.onHand}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => quick(1)}
            aria-label={`One more ${label}`}
            className="rounded-lg bg-white/10 p-1.5 transition-colors hover:bg-white/20 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-white/10 p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(Object.keys(MODE_META) as Mode[]).map((m) => {
              // Nowhere to send stock in a single-location store.
              if (m === "transfer" && targets.length === 0) return null;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors ${
                    mode === m
                      ? "bg-white text-[#0b0f14]"
                      : "bg-white/10 hover:bg-white/20"
                  }`}
                >
                  {MODE_META[m].label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-24 flex-1">
              <span className="mb-1 block text-xs text-white/50">
                {mode === "count" ? "Counted" : "Quantity"}
              </span>
              <input
                value={value}
                inputMode="numeric"
                onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="0"
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-right outline-none focus:border-white/40"
              />
            </label>

            {mode === "transfer" && (
              <label className="min-w-36 flex-1">
                <span className="mb-1 block text-xs text-white/50">To</span>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 outline-none focus:border-white/40"
                >
                  {targets.map((t) => (
                    <option key={t.id} value={t.id} className="bg-[#0b0f14]">
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="min-w-36 flex-[2]">
              <span className="mb-1 block text-xs text-white/50">
                Reason (optional)
              </span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  mode === "count" ? "e.g. weekly stocktake" : "e.g. damaged"
                }
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 outline-none focus:border-white/40"
              />
            </label>

            <button
              type="button"
              disabled={pending || !valid}
              onClick={submit}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : mode === "transfer" ? (
                <Send className="h-4 w-4" strokeWidth={2} />
              ) : null}
              {MODE_META[mode].verb}
            </button>
          </div>

          {mode === "count" && (
            <p className="mt-2 text-xs text-white/40">
              Saved as the difference from {item.onHand}, so a sale rung while
              you were counting isn&apos;t wiped out.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
